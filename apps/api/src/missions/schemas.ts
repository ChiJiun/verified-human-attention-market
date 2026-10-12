import { createHash } from "node:crypto";

import { z } from "zod";

import type { MissionDefinition } from "./types.js";

const identifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,32}$/, "Identifiers must be 1-32 [A-Za-z0-9_-]");

export const httpsUrlSchema = z
  .url()
  .refine(
    (value) => URL.canParse(value) && new URL(value).protocol === "https:",
    "Only https URLs are allowed",
  );

const questionSchema = z.object({
  id: identifierSchema,
  prompt: z.string().trim().min(1).max(500),
  choices: z
    .array(
      z.object({
        id: identifierSchema,
        label: z.string().trim().min(1).max(200),
      }),
    )
    .min(2)
    .max(6),
});

/** Mission fields supplied with campaign creation (contentUrl is separate). */
export const missionInputSchema = z
  .object({
    questions: z.array(questionSchema).min(1).max(3),
    answerKey: z.record(identifierSchema, identifierSchema),
    passThreshold: z.number().int().min(1).optional(),
  })
  .superRefine((value, context) => {
    const questionIds = new Set<string>();

    value.questions.forEach((question, index) => {
      if (questionIds.has(question.id)) {
        context.addIssue({
          code: "custom",
          path: ["questions", index, "id"],
          message: "Duplicate question id",
        });
      }
      questionIds.add(question.id);

      const choiceIds = new Set(question.choices.map((choice) => choice.id));
      if (choiceIds.size !== question.choices.length) {
        context.addIssue({
          code: "custom",
          path: ["questions", index, "choices"],
          message: "Duplicate choice id",
        });
      }

      const correct = value.answerKey[question.id];
      if (correct === undefined || !choiceIds.has(correct)) {
        context.addIssue({
          code: "custom",
          path: ["answerKey", question.id],
          message: "Answer key must name a valid choice for every question",
        });
      }
    });

    for (const key of Object.keys(value.answerKey)) {
      if (!questionIds.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["answerKey", key],
          message: "Answer key references an unknown question",
        });
      }
    }

    if (
      value.passThreshold !== undefined &&
      value.passThreshold > value.questions.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["passThreshold"],
        message: "passThreshold cannot exceed the number of questions",
      });
    }
  });

export type MissionInput = z.infer<typeof missionInputSchema>;

export function toMissionDefinition(
  contentUrl: string,
  input: MissionInput,
): MissionDefinition {
  return {
    contentUrl,
    questions: input.questions,
    answerKey: input.answerKey,
    passThreshold: input.passThreshold ?? input.questions.length,
  };
}

/** Key-order independent JSON used for hashing/idempotency. */
export function canonicalMission(definition: MissionDefinition) {
  return {
    contentUrl: definition.contentUrl,
    questions: definition.questions.map((question) => ({
      id: question.id,
      prompt: question.prompt,
      choices: question.choices.map((choice) => ({
        id: choice.id,
        label: choice.label,
      })),
    })),
    answerKey: Object.entries(definition.answerKey).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
    passThreshold: definition.passThreshold,
  };
}

export function hashMissionDefinition(definition: MissionDefinition): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalMission(definition)))
    .digest("hex");
}

/** Participant answer payload: one choice per question. */
export const submittedAnswersSchema = z
  .array(
    z.object({
      questionId: identifierSchema,
      choiceId: identifierSchema,
    }),
  )
  .min(1)
  .max(3);

export type SubmittedAnswers = z.infer<typeof submittedAnswersSchema>;
