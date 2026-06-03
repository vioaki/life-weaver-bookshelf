export type BookStatus = "ongoing" | "finished";

export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface Relationship {
  name: string;
  relation?: string;
  emoji?: string;
  bond?: "good" | "neutral" | "bad" | "dead";
  note?: string;
}

export interface Delta {
  k: string;
  d: number;
}

export interface LifeState {
  name?: string;
  gender?: string;
  avatar?: string;
  age?: number;
  world?: string;
  oneline?: string;
  era_label?: string;
  stats?: Record<string, number>;
  extra?: Record<string, string | number | boolean>;
  deltas?: Delta[];
  relationships?: Relationship[];
  event?: string;
  timeline_add?: string;
  choices?: string[];
  dead?: boolean;
  death?: Finale | null;
  timeline?: Array<{ age?: number; t: string }>;
}

export interface Finale {
  cause?: string;
  title?: string;
  summary?: string;
  analysis?: string;
}

export interface BookPage {
  era_label: string;
  narrative: string;
  event: string;
  deltas: Delta[];
  choiceMade: string;
  choices: string[];
  dead: boolean;
  death: Finale | null;
}

export interface BookRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: BookStatus;
  protagonist: string;
  world: string;
  avatar: string;
  coverStyle: {
    seal: string;
    paper: string;
  };
  pages: BookPage[];
  history: ChatMessage[];
  state: LifeState;
  finale: Finale | null;
  summaryLine: string;
}

export interface AppConfig {
  url: string;
  key: string;
  model: string;
  temperature: number;
  style: string;
  custom: string;
}

export type View = "home" | "shelf" | "reader";
