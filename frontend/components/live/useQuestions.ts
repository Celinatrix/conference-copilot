'use client';

import { useCallback, useState } from 'react';
import type { QuestionDto } from '@conference-copilot/shared';
import { api } from '@/lib/api';
import type { LiveEvent } from '@/lib/live';

type QuestionsResponse = { questions: QuestionDto[]; spentUsd: number; autoBudgetUsd: number };

/** Questions detected in (or asked about) the live transcript, with their suggested answers as they stream in. */
export function useQuestions(conferenceId: string) {
  const [questions, setQuestions] = useState<QuestionDto[]>([]);
  /** Raw answer text still streaming, per question id. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [budget, setBudget] = useState<{ spentUsd: number; autoBudgetUsd: number } | null>(null);

  const load = useCallback(async () => {
    const r = await api<QuestionsResponse>(`/api/conferences/${conferenceId}/questions`);
    setQuestions(r.questions);
    setBudget({ spentUsd: r.spentUsd, autoBudgetUsd: r.autoBudgetUsd });
  }, [conferenceId]);

  const upsert = useCallback((q: QuestionDto) => {
    setQuestions((prev) => (prev.some((p) => p.id === q.id) ? prev.map((p) => (p.id === q.id ? q : p)) : [q, ...prev]));
    if (q.status !== 'answering') setDrafts(({ [q.id]: _, ...rest }) => rest);
  }, []);

  /** Applies question events from the live socket; returns false for events it does not handle. */
  const applyEvent = useCallback(
    (e: LiveEvent): boolean => {
      if (e.type === 'question') {
        upsert(e.question);
        return true;
      }
      if (e.type === 'answer.delta') {
        setDrafts((d) => ({ ...d, [e.questionId]: (d[e.questionId] ?? '') + e.delta }));
        return true;
      }
      return false;
    },
    [upsert],
  );

  /** Ask for a suggestion: free text, or one transcript segment. The answer streams in over the socket. */
  const ask = useCallback(
    async (input: { text: string } | { segmentId: string }) => {
      const { question } = await api<{ question: QuestionDto }>(`/api/conferences/${conferenceId}/questions`, { method: 'POST', json: input });
      upsert(question);
    },
    [conferenceId, upsert],
  );

  /** Draft (or re-draft) the answer to a question that is waiting, failed, or needs a fresh take. */
  const answer = useCallback(async (questionId: string) => {
    await api(`/api/questions/${questionId}/answer`, { method: 'POST' });
  }, []);

  return { questions, drafts, budget, load, applyEvent, ask, answer };
}

export type QuestionsState = ReturnType<typeof useQuestions>;
