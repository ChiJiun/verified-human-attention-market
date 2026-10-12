export interface MissionChoice {
  id: string;
  label: string;
}

export interface MissionQuestion {
  id: string;
  prompt: string;
  choices: MissionChoice[];
}

/** Server-side mission definition. `answerKey` must never leave the API. */
export interface MissionDefinition {
  contentUrl: string;
  questions: MissionQuestion[];
  /** questionId -> correct choiceId */
  answerKey: Record<string, string>;
  /** Minimum number of correct answers required to accept. */
  passThreshold: number;
}

export interface MissionRecord extends MissionDefinition {
  id: string;
  campaignId: string;
  version: number;
  kind: "comprehension_check";
  definitionHash: string;
  createdAt: Date;
}

/** What a participant is allowed to see. */
export interface PublicMission {
  missionId: string;
  campaignId: string;
  version: number;
  kind: "comprehension_check";
  contentUrl: string;
  questions: MissionQuestion[];
}
