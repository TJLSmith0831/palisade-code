import { useState } from "react";
import { Alert, Button, Group, Paper, Radio, Stack, Text, TextInput } from "@mantine/core";
import { invoke } from "@tauri-apps/api/core";
import { describeError } from "./errors";

import type { QuestionRequest } from "./api";

export function QuestionCard({ event, resolved }: { event: QuestionRequest; resolved: boolean }) {
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
    <Paper withBorder p="md" radius="md" aria-label="Agent clarification">
      <Stack gap="md">
        <Text fw={600}>{event.message}</Text>
        {done ? <Text size="sm" c="dimmed">Question closed</Text> : <>
          {event.fields.map((field) => field.options.length ? (
            <Radio.Group key={field.id} name={`${event.id}-${field.id}`} label={field.title} description={field.description} required={field.required}
              value={answers[field.id] ?? ""} onChange={(value) => setAnswers((current) => ({ ...current, [field.id]: value }))}>
              <Stack gap="xs" mt="xs">
                {field.options.map((option) => <Radio key={option.value} value={option.value} label={option.label} description={option.description} disabled={submitting} />)}
              </Stack>
            </Radio.Group>
          ) : (
            <TextInput key={field.id} label={field.title} description={field.description} required={field.required} type={field.secret ? "password" : "text"}
              value={answers[field.id] ?? ""} disabled={submitting} onChange={(event) => {
                const value = event.currentTarget.value;
                setAnswers((current) => ({ ...current, [field.id]: value }));
              }} />
          ))}
          {error && <Alert color="danger" role="alert">{error}</Alert>}
          <Group justify="flex-end"><Button onClick={submit} loading={submitting} disabled={!complete}>Send answers</Button></Group>
        </>}
      </Stack>
    </Paper>
  );
}
