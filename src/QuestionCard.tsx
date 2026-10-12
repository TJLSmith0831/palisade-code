import { useId, useState } from "react";
import { Alert, Button, Group, Paper, Radio, Stack, Text, TextInput } from "@mantine/core";
import { IconCheck, IconMessageCircleQuestion } from "@tabler/icons-react";
import { invoke } from "@tauri-apps/api/core";
import { describeError } from "./errors";

import type { QuestionRequest } from "./api";

export function QuestionCard({ event, resolved }: { event: QuestionRequest; resolved: boolean }) {
  const cardId = useId();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const complete = event.fields.every((field) => !field.required || answers[field.id]?.trim());
  const done = resolved || submitted;
  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await invoke("answer_question_prompt", { sessionId: event.sessionId, requestId: event.id, answers });
      setSubmitted(true);
    } catch (cause) {
      setError(describeError(cause, { action: "send your answers" }));
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <Paper withBorder p="md" radius="lg" className="question-card" aria-label="Agent clarification" aria-busy={submitting}>
      {done ? <Group gap="sm">
        {submitted && <IconCheck size={14} stroke={2} aria-hidden />}
        <Text size="sm" c="dimmed">{submitted ? "Answer sent" : "Question closed"}</Text>
      </Group> : <Stack gap="lg">
        <Group gap="sm" wrap="nowrap" className="question-context">
          <IconMessageCircleQuestion size={16} stroke={1.5} aria-hidden />
          <Text size="sm" c="dimmed">{event.message}</Text>
        </Group>
        {event.fields.map((field, fieldIndex) => field.options.length ? (
          <Radio.Group key={field.id} name={`${cardId}-${fieldIndex}`} label={field.title} description={field.description === "Clarification" ? undefined : field.description} required={field.required} classNames={{ label: "question-label" }}
            value={answers[field.id] ?? ""} onChange={(value) => setAnswers((current) => ({ ...current, [field.id]: value }))}>
            <Stack gap="sm" mt="md">
              {field.options.map((option, optionIndex) => <Radio.Card key={option.value} value={option.value} radius="xs" className="question-option" disabled={submitting}
                aria-label={option.label} aria-describedby={option.description ? `${cardId}-${fieldIndex}-${optionIndex}` : undefined}>
                <Group gap="md" wrap="nowrap">
                  <Radio.Indicator size={14} disabled={submitting} aria-hidden />
                  <Stack gap="xs" className="question-option-copy">
                    <Text size="md" lh={1.5}>{option.label}</Text>
                    {option.description && <Text id={`${cardId}-${fieldIndex}-${optionIndex}`} size="sm" c="dimmed" lh={1.5}>{option.description}</Text>}
                  </Stack>
                </Group>
              </Radio.Card>)}
            </Stack>
          </Radio.Group>
        ) : (
          <TextInput key={field.id} label={field.title} description={field.description} required={field.required} classNames={{ label: "question-label" }} type={field.secret ? "password" : "text"}
            value={answers[field.id] ?? ""} disabled={submitting} onChange={(event) => {
              const value = event.currentTarget.value;
              setAnswers((current) => ({ ...current, [field.id]: value }));
            }} />
        ))}
        {error && <Alert color="danger" role="alert">{error}</Alert>}
        <Group justify="space-between" wrap="wrap">
          {!complete && <Text size="sm" c="dimmed">Answer to continue</Text>}
          <Button size="sm" ml="auto" onClick={submit} loading={submitting} disabled={!complete}>Send answers</Button>
        </Group>
      </Stack>}
    </Paper>
  );
}
