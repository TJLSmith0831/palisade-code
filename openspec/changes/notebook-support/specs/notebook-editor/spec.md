## Purpose

Lets users view, edit, and run Jupyter notebooks (`.ipynb`) as notebooks — cells with rendered markdown, syntax-highlighted code, and live execution against a kernel — instead of as raw JSON text.

## ADDED Requirements

### Requirement: Notebook files render as cells, not raw text
The system SHALL detect `.ipynb` files opened from the file tree or the fuzzy-open palette and render them as a sequence of cells (markdown and code), replacing the plain-text/JSON view used for unrecognized file types.

#### Scenario: Opening a notebook from the file tree
- **WHEN** user clicks a `.ipynb` file in the file tree
- **THEN** the notebook opens as a cell-by-cell view, not as raw JSON text

#### Scenario: Opening a notebook from the fuzzy-open palette
- **WHEN** user triggers the fuzzy-open palette, types a partial filename matching a `.ipynb` file, and selects it
- **THEN** the notebook opens as a cell-by-cell view

### Requirement: Markdown cells render as formatted prose
The system SHALL render a markdown cell's source as formatted markdown (headings, lists, emphasis, links, inline code) rather than raw text, using the same sanitized rendering already used elsewhere in the app.

#### Scenario: Viewing a markdown cell
- **WHEN** a notebook contains a markdown cell
- **THEN** the cell displays its source rendered as formatted markdown, not as raw markdown syntax

### Requirement: Code cells display with syntax highlighting and are directly editable
The system SHALL display each code cell's source with language-appropriate syntax highlighting and allow direct text editing of that source.

#### Scenario: Viewing a code cell
- **WHEN** a notebook contains a code cell
- **THEN** the cell's source displays with syntax highlighting

#### Scenario: Editing a code cell's source
- **WHEN** user types in a code cell
- **THEN** the cell's source updates and the notebook shows an unsaved-changes indicator until saved

### Requirement: Structural cell editing
The system SHALL let the user add a new cell, delete an existing cell, reorder cells (move up/down), and toggle a cell between code and markdown type.

#### Scenario: Adding a cell
- **WHEN** user chooses to add a cell at a given position
- **THEN** a new empty cell (code by default) is inserted at that position

#### Scenario: Deleting a cell
- **WHEN** user deletes a cell
- **THEN** the cell is removed from the notebook and no longer displayed

#### Scenario: Reordering a cell
- **WHEN** user moves a cell up or down
- **THEN** the cell's position in the notebook changes accordingly

#### Scenario: Changing a cell's type
- **WHEN** user toggles a cell between code and markdown
- **THEN** the cell's source is preserved and it renders/edits according to the new type

### Requirement: Explicit save for structural and source edits
The system SHALL write cell source, structure (add/delete/reorder/type), and metadata changes to the notebook file on disk when the user explicitly saves (matching the app's existing save model), and SHALL show a dirty indicator while such changes are unsaved. Running any cell also saves the whole notebook (see "Cell output persists automatically after execution"), so the dirty indicator clears on either explicit save or a cell run.

#### Scenario: Saving edits
- **WHEN** user invokes save with unsaved cell edits present
- **THEN** the notebook file on disk is updated to reflect the current cell content and structure, and the dirty indicator clears

#### Scenario: Running a cell while other edits are unsaved
- **WHEN** user runs a cell while other cells have unsaved source or structural edits
- **THEN** the whole notebook (including those other pending edits) is written to disk when the run completes, and the dirty indicator clears

### Requirement: Running a cell executes it against a live kernel
The system SHALL let the user run a code cell, sending its source for execution against a kernel associated with the notebook and displaying returned output inline under the cell. The kernel SHALL start on demand, the first time any cell in the notebook is run — not when the notebook is opened.

#### Scenario: Running the first cell in a newly opened notebook
- **WHEN** user runs a cell in a notebook that has no kernel running yet
- **THEN** the system starts a kernel for the notebook (showing a starting-kernel indicator) and then executes the cell once the kernel is ready

#### Scenario: Running a cell with a kernel already running
- **WHEN** user runs a cell in a notebook whose kernel is already running
- **THEN** the cell executes immediately without a kernel-start delay

#### Scenario: Opening a notebook does not start a kernel
- **WHEN** user opens a notebook and does not run any cell
- **THEN** no kernel process is started for that notebook

### Requirement: Kernel is resolved from the notebook's own kernel specification
The system SHALL resolve which kernel to run using the notebook file's own recorded kernel specification. If that kernel specification cannot be found on the user's system, the system SHALL warn (non-fatally) and fall back to the system's default Python interpreter.

#### Scenario: Notebook's kernelspec is available
- **WHEN** user runs a cell in a notebook whose recorded kernel specification is installed on the system
- **THEN** the cell executes using that specific kernel

#### Scenario: Notebook's kernelspec is missing
- **WHEN** user runs a cell in a notebook whose recorded kernel specification is not found on the system
- **THEN** the system shows a non-blocking warning and executes the cell using the system default Python interpreter instead

#### Scenario: No usable Python/kernel found at all
- **WHEN** user runs a cell and no kernel (named or default) can be found on the user's system
- **THEN** the system shows a clear error explaining that no kernel is available, and does not crash

### Requirement: Cell output renders inline, including text, images, and errors
The system SHALL render, directly under the executed cell: standard output/error text streamed during execution, plain-text results, image results (rendered as images, not raw encoded data), and errors (with the traceback shown, not just a generic failure message). Output types the system does not render SHALL fall back to their plain-text representation without causing an error.

#### Scenario: Cell produces text output
- **WHEN** an executed cell writes to standard output or returns a plain-text result
- **THEN** that text appears under the cell

#### Scenario: Cell produces an image output
- **WHEN** an executed cell returns image data (e.g. a plot)
- **THEN** the image renders visually under the cell, not as raw encoded text

#### Scenario: Cell execution raises an error
- **WHEN** an executed cell raises an error
- **THEN** the error and its traceback render under the cell, visually distinguished from normal output

#### Scenario: Cell produces an unsupported rich output type
- **WHEN** an executed cell returns an output type the system does not have a dedicated renderer for
- **THEN** the system displays that output's plain-text fallback representation instead of failing or showing nothing

### Requirement: Cell output persists automatically after execution
The system SHALL write the notebook file to disk automatically when a cell's execution completes, including that cell's new output and execution count, without the user needing to explicitly save.

#### Scenario: Output written after a successful run
- **WHEN** a cell finishes executing and produces output
- **THEN** the notebook file on disk reflects that output without the user needing to explicitly save

### Requirement: Kernel interrupt and restart
The system SHALL let the user interrupt a currently running cell's execution and restart the notebook's kernel, discarding its in-process state.

#### Scenario: Interrupting a long-running cell
- **WHEN** user chooses to interrupt while a cell is executing
- **THEN** execution stops and the cell shows that it was interrupted rather than completed

#### Scenario: Restarting the kernel
- **WHEN** user chooses to restart the kernel
- **THEN** the running kernel is stopped, a fresh kernel is started on the next cell run, and previously defined variables/state no longer persist

### Requirement: Kernel process lifecycle is tied to the notebook's session
The system SHALL stop a notebook's kernel process when its tab is closed or when the app quits, so kernel processes do not accumulate across a long-running session.

#### Scenario: Closing a notebook tab with a running kernel
- **WHEN** user closes a notebook tab whose kernel is running
- **THEN** the kernel process is stopped

#### Scenario: Quitting the app with notebooks open
- **WHEN** the app quits while one or more notebooks have running kernels
- **THEN** all of those kernel processes are stopped

### Requirement: Notebook export
The system SHALL let the user export the current notebook to a plain Python script and to an HTML document.

#### Scenario: Exporting to a script
- **WHEN** user chooses to export the notebook as a script
- **THEN** the system produces a `.py` file containing the notebook's code cells

#### Scenario: Exporting to HTML
- **WHEN** user chooses to export the notebook as HTML
- **THEN** the system produces an HTML document representing the notebook's cells and their last-saved outputs
