"use client";

import { useState } from "react";

import {
  emptyQuestion,
  toCampaignPayload,
  type CampaignDraft,
} from "../../lib/campaign-form";

export type CampaignPayload = Extract<
  ReturnType<typeof toCampaignPayload>,
  { ok: true }
>["payload"];

function localInput(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function CampaignForm(props: {
  advertiser: string;
  busy: boolean;
  onSubmit: (payload: CampaignPayload) => void;
}) {
  const now = Date.now();
  const [draft, setDraft] = useState<CampaignDraft>({
    contentUrl: "https://",
    reward: "1",
    maxCompletions: 10,
    startAt: localInput(new Date(now + 15 * 60_000)),
    endAt: localInput(new Date(now + 75 * 60_000)),
    questions: [emptyQuestion()],
  });
  const [errors, setErrors] = useState<string[]>([]);

  const update = (patch: Partial<CampaignDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));

  const updateQuestion = (
    index: number,
    patch: Partial<CampaignDraft["questions"][number]>,
  ) =>
    update({
      questions: draft.questions.map((question, position) =>
        position === index ? { ...question, ...patch } : question,
      ),
    });

  return (
    <form
      className="card"
      onSubmit={(event) => {
        event.preventDefault();
        const result = toCampaignPayload(draft, props.advertiser);
        setErrors(result.ok ? [] : result.errors);
        if (result.ok) props.onSubmit(result.payload);
      }}
    >
      <h2>Create campaign</h2>

      <label>
        Sponsored content URL
        <input
          value={draft.contentUrl}
          onChange={(event) => update({ contentUrl: event.target.value })}
          inputMode="url"
          required
        />
      </label>

      <div className="row">
        <label>
          Reward per completion (USDC)
          <input
            value={draft.reward}
            onChange={(event) => update({ reward: event.target.value })}
            inputMode="decimal"
            required
          />
        </label>
        <label>
          Max completions
          <input
            type="number"
            min={1}
            max={10}
            value={draft.maxCompletions}
            onChange={(event) =>
              update({ maxCompletions: Number(event.target.value) })
            }
          />
        </label>
      </div>

      <div className="row">
        <label>
          Start
          <input
            type="datetime-local"
            value={draft.startAt}
            onChange={(event) => update({ startAt: event.target.value })}
          />
        </label>
        <label>
          End
          <input
            type="datetime-local"
            value={draft.endAt}
            onChange={(event) => update({ endAt: event.target.value })}
          />
        </label>
      </div>

      <h3>Comprehension check (1–3 questions)</h3>
      {draft.questions.map((question, index) => (
        <fieldset key={index}>
          <legend>Question {index + 1}</legend>
          <input
            placeholder="Question"
            value={question.prompt}
            onChange={(event) =>
              updateQuestion(index, { prompt: event.target.value })
            }
          />
          {question.choices.map((choice, choiceIndex) => (
            <div className="choice" key={choiceIndex}>
              <input
                type="radio"
                name={`correct-${index}`}
                checked={question.correctIndex === choiceIndex}
                onChange={() =>
                  updateQuestion(index, { correctIndex: choiceIndex })
                }
                aria-label={`Choice ${choiceIndex + 1} is correct`}
              />
              <input
                placeholder={`Choice ${choiceIndex + 1}`}
                value={choice}
                onChange={(event) =>
                  updateQuestion(index, {
                    choices: question.choices.map((value, position) =>
                      position === choiceIndex ? event.target.value : value,
                    ),
                  })
                }
              />
            </div>
          ))}
          <div className="actions">
            {question.choices.length < 6 && (
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  updateQuestion(index, {
                    choices: [...question.choices, ""],
                  })
                }
              >
                Add choice
              </button>
            )}
            {draft.questions.length > 1 && (
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  update({
                    questions: draft.questions.filter(
                      (_question, position) => position !== index,
                    ),
                  })
                }
              >
                Remove question
              </button>
            )}
          </div>
        </fieldset>
      ))}
      {draft.questions.length < 3 && (
        <button
          type="button"
          className="secondary"
          onClick={() =>
            update({ questions: [...draft.questions, emptyQuestion()] })
          }
        >
          Add question
        </button>
      )}

      {errors.length > 0 && (
        <ul className="error">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}

      <button type="submit" disabled={props.busy}>
        {props.busy ? "Saving…" : "Save draft"}
      </button>
    </form>
  );
}
