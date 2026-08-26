//! Turning one test command's console output into per-test results.
//!
//! This is a *view* of a verify run, never a new source of truth. A parsed
//! "12 passed" is still just an exit code with structure on top — the
//! `VerificationRun` (command, exit code, commit) remains the evidence, and
//! nothing here may be read as a spec being satisfied (D3).
//!
//! Deliberately parses console output rather than requiring a JSON reporter
//! flag: the user's `verify` command is whatever they already run, and
//! rewriting it behind their back would change what the evidence records.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TestStatus {
    Passed,
    Failed,
    Skipped,
    /// The test did not finish cleanly — a panic outside an assertion, a
    /// segfault, an unhandled rejection. Distinct from `Failed` because
    /// "the suite fell over here" is different news from "this assertion
    /// was wrong".
    Errored,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestCase {
    /// Full test name as the framework printed it, including any suite path.
    pub name: String,
    pub status: TestStatus,
    /// Project-relative source file, when the framework named one.
    pub file: Option<String>,
    /// 1-based line, for the editor gutter.
    pub line: Option<u32>,
    /// The failure message, trimmed. `None` for a passing test.
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestReport {
    /// Which parser matched: "cargo", "vitest", "pytest", "go", or "none".
    pub framework: String,
    /// In the order the framework reported them — never re-sorted, so a
    /// re-run of a deterministic suite produces an identical list.
    pub cases: Vec<TestCase>,
    /// False when no parser recognised the output. The UI must then fall
    /// back to the raw log rather than showing an empty, green-looking
    /// explorer: "no failures parsed" is not "no failures".
    pub parsed: bool,
    /// The command exited non-zero but no individual test did — a linker
    /// error, an OOM-killed worker, a crash before the first verdict.
    /// Surfaced rather than swallowed: an explorer full of green ticks under
    /// a red exit code is the exact dishonesty this app exists to avoid.
    #[serde(default)]
    pub unexplained_failure: bool,
}

impl TestReport {
    fn unparsed() -> Self {
        TestReport {
            framework: "none".into(),
            cases: vec![],
            parsed: false,
            unexplained_failure: false,
        }
    }
}

/// Parses test output, trying each known framework and taking the first that
/// recognises anything.
pub fn parse(output: &str) -> TestReport {
    for (framework, parser) in [
        ("cargo", parse_cargo as fn(&str) -> Vec<TestCase>),
        ("vitest", parse_vitest),
        ("pytest", parse_pytest),
        ("go", parse_go),
    ] {
        let cases = parser(output);
        if !cases.is_empty() {
            return TestReport {
                framework: framework.into(),
                cases,
                parsed: true,
                unexplained_failure: false,
            };
        }
    }
    TestReport::unparsed()
}

/// `parse`, plus the one thing the exit code knows that the output doesn't:
/// whether a non-zero exit is accounted for by a test that actually failed.
pub fn report(output: &str, exit_code: i32) -> TestReport {
    let mut report = parse(output);
    let explained = report
        .cases
        .iter()
        .any(|c| matches!(c.status, TestStatus::Failed | TestStatus::Errored));
    report.unexplained_failure = exit_code != 0 && !explained;
    report
}

/// Strips ANSI SGR sequences. Test runners colour their output, and a
/// coloured `✓` is `\x1b[32m✓\x1b[39m` — invisible to a plain prefix match.
fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        }
    }
    out
}

fn clean_lines(output: &str) -> Vec<String> {
    output.lines().map(strip_ansi).collect()
}

/// `path/to/file.rs:12:5` → (file, line). Takes the *last* such reference on
/// the line, which is where every runner puts the location.
fn file_line(text: &str) -> Option<(String, u32)> {
    let mut best: Option<(String, u32)> = None;
    for token in text.split(|c: char| c.is_whitespace() || c == '(' || c == ')') {
        let token = token.trim_matches(|c| c == '"' || c == '\'' || c == ',');
        let mut parts = token.split(':');
        let file = parts.next()?;
        if !file.contains('.') || file.is_empty() {
            continue;
        }
        let Some(line) = parts.next().and_then(|n| n.parse::<u32>().ok()) else { continue };
        best = Some((file.to_string(), line));
    }
    best
}

// ------------------------------------------------------------------- cargo

/// `cargo test`: one `test name ... ok` line per test, then a `failures:`
/// section carrying each failure's panic message and location.
fn parse_cargo(output: &str) -> Vec<TestCase> {
    let lines = clean_lines(output);
    let mut cases: Vec<TestCase> = vec![];
    for line in &lines {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("test ") else { continue };
        let Some((name, verdict)) = rest.rsplit_once(" ... ") else { continue };
        // "test result: ok. 3 passed" also starts with "test " — the split
        // above rejects it (no " ... "), but guard the summary form too.
        if name.starts_with("result:") {
            continue;
        }
        let status = match verdict.trim() {
            "ok" => TestStatus::Passed,
            "FAILED" => TestStatus::Failed,
            v if v.starts_with("ignored") => TestStatus::Skipped,
            _ => continue,
        };
        cases.push(TestCase {
            name: name.trim().to_string(),
            status,
            file: None,
            line: None,
            message: None,
        });
    }
    attach_cargo_failures(&lines, &mut cases);
    cases
}

/// Walks the `---- name stdout ----` blocks and hangs each panic message and
/// `src/foo.rs:12:5` location onto the matching case.
fn attach_cargo_failures(lines: &[String], cases: &mut [TestCase]) {
    let mut current: Option<String> = None;
    let mut body: Vec<String> = vec![];
    let flush = |current: &mut Option<String>, body: &mut Vec<String>, cases: &mut [TestCase]| {
        let Some(name) = current.take() else { return };
        let text = std::mem::take(body).join("\n");
        let Some(case) = cases.iter_mut().find(|c| c.name == name) else { return };
        if let Some((file, line)) = text.lines().find_map(file_line) {
            case.file = Some(file);
            case.line = Some(line);
        }
        let message = text
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with("note:"))
            .collect::<Vec<_>>()
            .join("\n");
        if !message.is_empty() {
            case.message = Some(message);
        }
    };
    for line in lines {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("---- ") {
            flush(&mut current, &mut body, cases);
            current = rest.strip_suffix(" stdout ----").map(str::to_string);
            continue;
        }
        // The trailing `failures:` list repeats the names with no detail.
        if trimmed == "failures:" || trimmed.starts_with("test result:") {
            flush(&mut current, &mut body, cases);
            continue;
        }
        if current.is_some() {
            body.push(line.clone());
        }
    }
    flush(&mut current, &mut body, cases);
}

// ------------------------------------------------------------------ vitest

/// Vitest / Jest default reporter.
///
/// The per-test rows print a *bare* name (`✓ adds 1ms`) indented under a file
/// header (`❯ sample.test.ts (3 tests | 1 failed) 3ms`) — only the header
/// names the file, so parsing rows in isolation loses the attribution the
/// gutter needs. Failures are repeated below as `FAIL <file> > <suite> >
/// <name>` with the stack, which is where the line number comes from.
fn parse_vitest(output: &str) -> Vec<TestCase> {
    let lines = clean_lines(output);
    let mut cases: Vec<TestCase> = vec![];
    let mut current_file: Option<String> = None;
    for line in &lines {
        let trimmed = line.trim_start();
        let indented = line.len() - trimmed.len() >= 2;
        let Some(marker) = trimmed.chars().next() else { continue };
        if !matches!(marker, '✓' | '×' | '✗' | '↓' | '❯') {
            continue;
        }
        let rest = strip_duration(trimmed[marker.len_utf8()..].trim());
        if rest.is_empty() {
            continue;
        }
        // A file header: `<path> (N tests | ...)`. It sets the attribution
        // for the rows under it and is never itself a test.
        if let Some((path, _)) = rest.split_once(" (") {
            if path.contains('.') && rest.contains("test") {
                current_file = Some(path.trim().to_string());
                continue;
            }
        }
        // `❯` also prefixes stack frames (`❯ sample.test.ts:4:49`), which are
        // neither a header nor a test row.
        if marker == '❯' {
            continue;
        }
        // An un-indented row belongs to no file header — vitest only prints
        // that shape for the overall summary, never for a test.
        if !indented && current_file.is_none() {
            continue;
        }
        let status = match marker {
            '✓' => TestStatus::Passed,
            '↓' => TestStatus::Skipped,
            _ => TestStatus::Failed,
        };
        cases.push(TestCase {
            name: rest.to_string(),
            status,
            file: current_file.clone(),
            line: None,
            message: None,
        });
    }
    attach_vitest_failures(&lines, &mut cases);
    cases
}

/// Trims the trailing `12ms` / `1.2s` the reporter appends.
fn strip_duration(name: &str) -> &str {
    let trimmed = name.trim_end();
    let Some((head, last)) = trimmed.rsplit_once(char::is_whitespace) else { return trimmed };
    let is_duration = last
        .strip_suffix("ms")
        .or_else(|| last.strip_suffix('s'))
        .is_some_and(|n| n.parse::<f64>().is_ok());
    if is_duration {
        head.trim_end()
    } else {
        trimmed
    }
}

/// Vitest prints each failure as `FAIL <file> > <suite> > <name>`, then the
/// error, then a `❯ file:line:col` stack frame. The row above printed only
/// the bare name, so match on the tail of the qualified path.
fn attach_vitest_failures(lines: &[String], cases: &mut Vec<TestCase>) {
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        let errored = trimmed.starts_with("Unhandled Error");
        let Some(qualified) = trimmed
            .strip_prefix("FAIL ")
            .or_else(|| trimmed.strip_prefix("Unhandled Error in "))
        else {
            continue;
        };
        let qualified = qualified.trim();
        let bare = qualified.rsplit('>').next().unwrap_or(qualified).trim();
        let file = qualified.split('>').next().map(|f| f.trim().to_string());

        let mut message: Option<String> = None;
        let mut location: Option<(String, u32)> = None;
        for follow in lines.iter().skip(index + 1).take(30) {
            let text = follow.trim();
            if text.starts_with("FAIL ") {
                break;
            }
            if message.is_none() && (text.contains("Error:") || text.contains("Error(")) {
                message = Some(text.to_string());
            }
            if location.is_none() {
                if let Some(rest) = text.strip_prefix('❯') {
                    location = file_line(rest.trim());
                }
            }
        }

        match cases.iter_mut().find(|c| c.name == bare && c.status != TestStatus::Passed) {
            Some(case) => {
                if errored {
                    case.status = TestStatus::Errored;
                }
                if let Some((file, line)) = location {
                    case.file = Some(file);
                    case.line = Some(line);
                }
                if message.is_some() {
                    case.message = message;
                }
            }
            // A crash with no `×` row above it: the test never got far enough
            // to be reported at all. Recording it is the whole point —
            // silence here would read as "everything passed".
            None if errored => {
                let (file, line) = match location {
                    Some((f, l)) => (Some(f), Some(l)),
                    None => (file, None),
                };
                cases.push(TestCase {
                    name: qualified.to_string(),
                    status: TestStatus::Errored,
                    file,
                    line,
                    message,
                });
            }
            None => {}
        }
    }
}

// ------------------------------------------------------------------ pytest

/// `pytest -v`: `tests/test_a.py::test_one PASSED`, with a `FAILED` summary
/// carrying the reason and a `path:line:` location in the traceback.
fn parse_pytest(output: &str) -> Vec<TestCase> {
    let lines = clean_lines(output);
    let mut cases: Vec<TestCase> = vec![];
    for line in &lines {
        let trimmed = line.trim();
        if !trimmed.contains("::") {
            continue;
        }
        let Some((id, verdict)) = trimmed.split_once(char::is_whitespace) else { continue };
        if !id.contains("::") || !id.split("::").next().is_some_and(|f| f.contains('.')) {
            continue;
        }
        let verdict = verdict.trim_start();
        let status = if verdict.starts_with("PASSED") {
            TestStatus::Passed
        } else if verdict.starts_with("FAILED") {
            TestStatus::Failed
        } else if verdict.starts_with("ERROR") {
            TestStatus::Errored
        } else if verdict.starts_with("SKIPPED") || verdict.starts_with("XFAIL") {
            TestStatus::Skipped
        } else {
            continue;
        };
        let file = id.split("::").next().map(str::to_string);
        cases.push(TestCase { name: id.to_string(), status, file, line: None, message: None });
    }
    attach_pytest_details(&lines, &mut cases);
    cases
}

/// Hangs each failure's reason and traceback line onto its own case.
///
/// Both have to be attributed by section header (`____ test_two ____`), not
/// by file: two failures in one file both print `tests/test_a.py:N`, and
/// matching on the file alone gives every failure the first one's line — a
/// gutter marker on the wrong statement.
fn attach_pytest_details(lines: &[String], cases: &mut [TestCase]) {
    let mut section: Option<String> = None;
    let mut reason: Vec<String> = vec![];

    for line in lines {
        let trimmed = line.trim();

        if let Some(name) = section_header(trimmed) {
            flush_pytest_section(&mut section, &mut reason, cases);
            section = Some(name);
            continue;
        }
        // A banner (`==== short test summary info ====`) ends the last one.
        if trimmed.starts_with('=') {
            flush_pytest_section(&mut section, &mut reason, cases);
            continue;
        }

        let Some(current) = section.clone() else {
            // Outside the FAILURES block, the only useful line is the short
            // summary — kept as a fallback for runs with no traceback
            // (`--tb=no`), where it is all there is.
            summary_reason(trimmed, cases);
            continue;
        };

        // `E       AssertionError: assert 100 == 99` — the real message.
        // pytest elides this in its short summary (`AssertionError...`), so
        // the traceback is the only place the assertion itself survives.
        if let Some(detail) = trimmed.strip_prefix("E ") {
            let detail = detail.trim();
            if !detail.is_empty() {
                reason.push(detail.to_string());
            }
            continue;
        }

        // `tests/test_app.py:24:` — a frame location. The *first* one in the
        // section is the test's own line, which is where the user put the
        // test and what the gutter should mark; later ones descend into
        // callees. Deeper frames are skipped by only taking the first.
        let Some((location, _)) = trimmed.split_once(':') else { continue };
        if !location.contains('.') || location.contains(' ') {
            continue;
        }
        let Some((file, line_no)) = file_line(trimmed) else { continue };
        let suffix = format!("::{current}");
        for case in cases.iter_mut() {
            if case.status != TestStatus::Passed
                && case.line.is_none()
                && case.name.ends_with(&suffix)
                && case.file.as_deref() == Some(file.as_str())
            {
                case.line = Some(line_no);
            }
        }
    }
    flush_pytest_section(&mut section, &mut reason, cases);
}

/// `___________ test_two ___________`, but not the `_ _ _ _ _` rules pytest
/// draws *between frames of one failure* — read as a header those renamed
/// the current section to nonsense, and every location after one was
/// attributed to no test at all.
fn section_header(trimmed: &str) -> Option<String> {
    if !trimmed.starts_with('_') || !trimmed.ends_with('_') {
        return None;
    }
    let name = trimmed.trim_matches('_').trim();
    if name.is_empty() {
        return None;
    }
    // `_ _ _ _ _` survives the trim as `_ _ _`: every token is a lone
    // underscore. A real header leaves the test's name behind.
    if name.split_whitespace().all(|token| token.chars().all(|c| c == '_')) {
        return None;
    }
    Some(name.to_string())
}

fn flush_pytest_section(
    section: &mut Option<String>,
    reason: &mut Vec<String>,
    cases: &mut [TestCase],
) {
    let Some(name) = section.take() else {
        reason.clear();
        return;
    };
    let message = std::mem::take(reason).join("\n");
    if message.is_empty() {
        return;
    }
    let suffix = format!("::{name}");
    for case in cases.iter_mut() {
        if case.name.ends_with(&suffix) {
            case.message = Some(message.clone());
        }
    }
}

/// `FAILED tests/test_a.py::test_two - assert 1 == 2`. Only used where the
/// traceback gave nothing, since pytest truncates this line.
fn summary_reason(trimmed: &str, cases: &mut [TestCase]) {
    for prefix in ["FAILED ", "ERROR "] {
        let Some(rest) = trimmed.strip_prefix(prefix) else { continue };
        let (id, reason) = rest.split_once(" - ").unwrap_or((rest, ""));
        if reason.is_empty() {
            continue;
        }
        if let Some(case) = cases.iter_mut().find(|c| c.name == id.trim()) {
            if case.message.is_none() {
                case.message = Some(reason.trim().to_string());
            }
        }
    }
}

// ---------------------------------------------------------------------- go

/// `go test -v`: `--- PASS: TestFoo (0.00s)`, failures preceded by
/// `foo_test.go:12: ...`.
fn parse_go(output: &str) -> Vec<TestCase> {
    let lines = clean_lines(output);
    let mut cases: Vec<TestCase> = vec![];
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix("--- ") else { continue };
        let (verdict, name) = rest.split_once(": ").unwrap_or((rest, ""));
        let status = match verdict {
            "PASS" => TestStatus::Passed,
            "FAIL" => TestStatus::Failed,
            "SKIP" => TestStatus::Skipped,
            _ => continue,
        };
        let name = name.split_whitespace().next().unwrap_or(name).to_string();
        if name.is_empty() {
            continue;
        }
        // Go prints the failure's location *above* its `--- FAIL` line.
        let (file, line_no, message) = if status == TestStatus::Failed {
            lines[..index]
                .iter()
                .rev()
                .take(10)
                .find_map(|prior| {
                    let prior = prior.trim();
                    let (location, reason) = prior.split_once(": ")?;
                    let (file, line_no) = file_line(location)?;
                    Some((Some(file), Some(line_no), Some(reason.trim().to_string())))
                })
                .unwrap_or((None, None, None))
        } else {
            (None, None, None)
        };
        cases.push(TestCase { name, status, file, line: line_no, message });
    }
    cases
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    /// Real output, captured from each runner rather than hand-written:
    /// a parser tuned to invented output is a parser that works on nothing.
    const CARGO: &str = include_str!("../tests/fixtures/cargo.txt");
    const VITEST: &str = include_str!("../tests/fixtures/vitest.txt");
    const PYTEST: &str = include_str!("../tests/fixtures/pytest.txt");
    const GO: &str = include_str!("../tests/fixtures/go.txt");
    /// A pytest run where one test crashes inside application code rather
    /// than failing an assertion — captured during the dogfood pass.
    const PYTEST_CRASH: &str = include_str!("../tests/fixtures/pytest_crash.txt");

    fn find<'a>(report: &'a TestReport, needle: &str) -> &'a TestCase {
        report
            .cases
            .iter()
            .find(|c| c.name.contains(needle))
            .unwrap_or_else(|| panic!("no case matching {needle:?} in {:?}", report.cases))
    }

    fn statuses(report: &TestReport) -> Vec<(&str, TestStatus)> {
        report.cases.iter().map(|c| (c.name.as_str(), c.status)).collect()
    }

    // ---------------------------------------------------------- cargo test

    #[test]
    fn cargo_mixed_suite_reports_every_test_with_its_own_verdict() {
        let report = parse(CARGO);
        assert_eq!(report.framework, "cargo");
        assert!(report.parsed);
        assert_eq!(report.cases.len(), 4, "{:?}", statuses(&report));
        assert_eq!(find(&report, "passes").status, TestStatus::Passed);
        assert_eq!(find(&report, "tests::fails").status, TestStatus::Failed);
        assert_eq!(find(&report, "ignored_one").status, TestStatus::Skipped);
        assert_eq!(find(&report, "panics_outright").status, TestStatus::Failed);
    }

    #[test]
    fn cargo_failure_carries_the_source_location_for_the_gutter() {
        let report = parse(CARGO);
        let failed = find(&report, "tests::fails");
        assert_eq!(failed.file.as_deref(), Some("src/lib.rs"));
        assert_eq!(failed.line, Some(9));
        assert!(
            failed.message.as_deref().unwrap_or("").contains("two is not three"),
            "message was {:?}",
            failed.message
        );
    }

    #[test]
    fn cargo_panic_outside_an_assertion_still_gets_a_location() {
        let panicked = parse(CARGO);
        let case = find(&panicked, "panics_outright");
        assert_eq!(case.file.as_deref(), Some("src/lib.rs"));
        assert_eq!(case.line, Some(14));
        assert!(case.message.as_deref().unwrap_or("").contains("index out of bounds"));
    }

    #[test]
    fn cargo_summary_line_is_not_mistaken_for_a_test() {
        let report = parse(CARGO);
        assert!(
            !report.cases.iter().any(|c| c.name.starts_with("result:")),
            "`test result: FAILED.` was parsed as a test: {:?}",
            statuses(&report)
        );
    }

    #[test]
    fn a_passing_cargo_test_carries_no_failure_detail() {
        let report = parse(CARGO);
        let passed = find(&report, "tests::passes");
        assert_eq!(passed.message, None);
        assert_eq!(passed.line, None);
    }

    // -------------------------------------------------------------- vitest

    #[test]
    fn vitest_mixed_suite_reports_pass_fail_and_skip() {
        let report = parse(VITEST);
        assert_eq!(report.framework, "vitest");
        assert_eq!(report.cases.len(), 3, "{:?}", statuses(&report));
        assert_eq!(find(&report, "adds").status, TestStatus::Passed);
        assert_eq!(find(&report, "subtracts wrongly").status, TestStatus::Failed);
        assert_eq!(find(&report, "is skipped").status, TestStatus::Skipped);
    }

    #[test]
    fn vitest_file_header_row_is_not_counted_as_a_test() {
        let report = parse(VITEST);
        // `❯ sample.test.ts (3 tests | 1 failed | 1 skipped) 3ms` summarises
        // the rows under it; counting it would double every file.
        assert!(
            !report.cases.iter().any(|c| c.name.contains("3 tests")),
            "file header parsed as a test: {:?}",
            statuses(&report)
        );
    }

    #[test]
    fn vitest_failure_carries_file_and_line_from_the_stack() {
        let report = parse(VITEST);
        let failed = find(&report, "subtracts wrongly");
        assert_eq!(failed.file.as_deref(), Some("sample.test.ts"));
        assert_eq!(failed.line, Some(4));
        assert!(
            failed.message.as_deref().unwrap_or("").contains("expected 2 to be 5"),
            "message was {:?}",
            failed.message
        );
    }

    #[test]
    fn vitest_tests_are_attributed_to_the_file_header_above_them() {
        let report = parse(VITEST);
        // The per-test rows print a bare name; only the header names the file.
        assert_eq!(find(&report, "adds").file.as_deref(), Some("sample.test.ts"));
    }

    #[test]
    fn vitest_output_with_ansi_colour_parses_the_same() {
        let coloured = VITEST
            .replace('✓', "\u{1b}[32m✓\u{1b}[39m")
            .replace('×', "\u{1b}[31m×\u{1b}[39m");
        let report = parse(&coloured);
        assert_eq!(report.cases.len(), 3, "{:?}", statuses(&report));
        assert_eq!(find(&report, "subtracts wrongly").status, TestStatus::Failed);
    }

    // -------------------------------------------------------------- pytest

    #[test]
    fn pytest_mixed_suite_reports_every_verdict() {
        let report = parse(PYTEST);
        assert_eq!(report.framework, "pytest");
        assert_eq!(report.cases.len(), 4, "{:?}", statuses(&report));
        assert_eq!(find(&report, "test_one").status, TestStatus::Passed);
        assert_eq!(find(&report, "test_two").status, TestStatus::Failed);
        assert_eq!(find(&report, "test_three").status, TestStatus::Skipped);
        assert_eq!(find(&report, "test_crashes").status, TestStatus::Failed);
    }

    #[test]
    fn pytest_failures_carry_reason_and_traceback_line() {
        let report = parse(PYTEST);
        let two = find(&report, "test_two");
        assert_eq!(two.file.as_deref(), Some("tests/test_a.py"));
        assert_eq!(two.line, Some(7));
        assert_eq!(two.message.as_deref(), Some("assert 1 == 2"));

        let crashed = find(&report, "test_crashes");
        assert_eq!(crashed.line, Some(14), "each failure gets its own line, not the first one's");
        assert_eq!(crashed.message.as_deref(), Some("RuntimeError: boom"));
    }

    // ------------------------------------------------------------ go test

    #[test]
    fn go_mixed_suite_reports_every_verdict() {
        let report = parse(GO);
        assert_eq!(report.framework, "go");
        assert_eq!(find(&report, "TestPasses").status, TestStatus::Passed);
        assert_eq!(find(&report, "TestFails").status, TestStatus::Failed);
        assert_eq!(find(&report, "TestSkipped").status, TestStatus::Skipped);
        assert_eq!(find(&report, "TestPanics").status, TestStatus::Failed);
    }

    #[test]
    fn go_failure_location_comes_from_the_line_above_it() {
        let report = parse(GO);
        let failed = find(&report, "TestFails");
        assert_eq!(failed.file.as_deref(), Some("main_test.go"));
        assert_eq!(failed.line, Some(8));
        assert_eq!(failed.message.as_deref(), Some("expected 2, got 3"));
    }

    #[test]
    fn go_skip_does_not_borrow_a_neighbours_failure_location() {
        let report = parse(GO);
        assert_eq!(find(&report, "TestSkipped").message, None);
    }


    // ------------------------------------ regressions found while dogfooding

    #[test]
    fn a_test_that_crashes_in_app_code_still_gets_its_own_test_line() {
        // Dogfood regression: the explorer showed no location at all for a
        // test that raised inside the application instead of failing an
        // assertion, so there was nothing to click and no gutter mark. The
        // traceback names the test's own line before descending into the
        // callee; that line is what the user asked for.
        let report = parse(PYTEST_CRASH);
        let crashed = find(&report, "test_convert_crashes_on_unknown_currency");
        assert_eq!(crashed.status, TestStatus::Failed);
        assert_eq!(crashed.file.as_deref(), Some("tests/test_app.py"));
        assert_eq!(crashed.line, Some(24), "{:?}", crashed);
    }

    #[test]
    fn the_dashed_separators_inside_a_traceback_are_not_section_headers() {
        // `_ _ _ _ _` divides frames within one failure. Read as a header it
        // renamed the current section to garbage, and every location after
        // it was attributed to nothing.
        let report = parse(PYTEST_CRASH);
        assert!(
            !report.cases.iter().any(|c| c.name.contains("_ _")),
            "a separator was parsed as a test: {:?}",
            statuses(&report)
        );
    }

    #[test]
    fn a_failure_message_comes_from_the_traceback_not_pytests_truncated_summary() {
        // Dogfood regression: every row read "AssertionError..." — pytest
        // elides the reason in its short summary. The `E` lines carry the
        // real one, which is the only part worth reading.
        let report = parse(PYTEST_CRASH);
        let failed = find(&report, "test_discount_ignores_unknown_code");
        let message = failed.message.as_deref().unwrap_or("");
        assert!(
            message.contains("assert 100 == 99"),
            "the actual assertion is missing: {message:?}"
        );
        assert!(!message.ends_with("..."), "still pytest's truncated summary: {message:?}");

        let crashed = find(&report, "test_convert_crashes_on_unknown_currency");
        assert!(
            crashed.message.as_deref().unwrap_or("").contains("KeyError: 'GBP'"),
            "crash reason lost: {:?}",
            crashed.message
        );
    }

    #[test]
    fn the_dogfood_suite_parses_with_the_verdicts_the_runner_printed() {
        let report = parse(PYTEST_CRASH);
        let tally = |want: TestStatus| {
            report.cases.iter().filter(|c| c.status == want).count()
        };
        assert_eq!(tally(TestStatus::Passed), 2);
        assert_eq!(tally(TestStatus::Failed), 2);
        assert_eq!(tally(TestStatus::Skipped), 1);
    }

    // ------------------------------------------------- order and staleness

    #[test]
    fn cases_keep_the_order_the_runner_printed_them_in() {
        let report = parse(GO);
        let names: Vec<&str> = report.cases.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["TestPasses", "TestFails", "TestSkipped", "TestPanics"]);
        // Parsing twice must produce byte-identical results: an explorer that
        // reshuffles between runs makes a diff impossible to read.
        assert_eq!(parse(GO), report);
    }

    // ------------------------------------------------ unrecognised output

    #[test]
    fn unrecognised_output_is_reported_as_unparsed_not_as_all_green() {
        let report = parse("Segmentation fault: 11\n");
        assert!(!report.parsed);
        assert_eq!(report.framework, "none");
        assert!(report.cases.is_empty());
    }

    #[test]
    fn empty_output_is_unparsed() {
        assert!(!parse("").parsed);
    }

    #[test]
    fn a_failing_command_with_no_failing_test_is_flagged_not_hidden() {
        // The runner died before reporting a verdict — a linker error, an
        // OOM kill, a crashed worker. Reporting "3 passed" here would be a
        // lie by omission, so the report says the exit code is unexplained.
        let output = "running 3 tests\ntest a ... ok\ntest b ... ok\ntest c ... ok\n";
        let clean = report(output, 0);
        assert!(!clean.unexplained_failure);

        let crashed = report(output, 101);
        assert!(
            crashed.unexplained_failure,
            "a non-zero exit with no failing test must be surfaced"
        );
        assert_eq!(crashed.cases.len(), 3, "the tests that did report still count");
    }

    #[test]
    fn a_failing_command_with_a_failing_test_is_fully_explained() {
        let crashed = report(CARGO, 101);
        assert!(!crashed.unexplained_failure);
    }

    #[test]
    fn unparsed_output_from_a_failing_command_is_also_unexplained() {
        let report = report("Segmentation fault: 11\n", 139);
        assert!(report.unexplained_failure);
        assert!(!report.parsed);
    }
}
