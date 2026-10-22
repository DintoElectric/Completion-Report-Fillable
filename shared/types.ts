import type { FileType } from './limits.ts';
import type { FieldKind } from './closeout.ts';

// Roles, lowest to highest. viewer: look and download. member: create jobs and upload documents.
// admin: also manage templates and delete anything. ADMIN_EMAILS (env var) makes someone admin.
export type Role = 'viewer' | 'member' | 'admin';

export interface Me {
  id: string;
  email: string;
  name: string;
  role: Role;
  limits: { maxFileBytes: number; chunkBytes: number };
  aiReady: boolean;               // false until ANTHROPIC_API_KEY is set in Netlify
}

export type FileKind = 'template' | 'source' | 'output';

export interface FileRow {
  id: string;
  kind: FileKind;
  template_id: string | null;
  job_id: string | null;
  file_name: string;
  file_type: FileType;
  size_bytes: number;
  chunk_count: number;
  upload_status: 'uploading' | 'ready';
  uploaded_by: string;
  uploaded_by_name: string | null;
  created_at: string;
}

export interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  file: FileRow | null;          // the template's current file (null until one is uploaded)
  job_count: number;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

export type JobStatus = 'draft' | 'filled';

export interface JobRow {
  id: string;
  name: string;
  template_id: string | null;
  template_name: string | null;
  status: JobStatus;
  notes: string | null;
  source_count: number;
  output_count: number;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobDetail extends JobRow {
  files: FileRow[];              // its sources and outputs, newest first
}

/* ---------- filling a template ---------- */
export type FillStatus = 'queued' | 'running' | 'ready' | 'failed';

/** One blank the AI is asked about. */
export interface AiFieldRequest {
  id: string;                 // the cell address
  group: string;
  label: string;
  kind: FieldKind;
  key: string;
  hint?: string;
  choices?: string[];
}

/** A document, already turned into text in the browser. */
export interface FillDocument { name: string; text: string }

/** A scanned PDF (no text layer), sent as the PDF itself for the AI to read. data is base64. */
export interface FillAttachment { name: string; data: string }

export interface FillRequest {
  job_id: string;
  fields: AiFieldRequest[];
  documents: FillDocument[];
  attachments?: FillAttachment[];
  digest?: string;            // a short summary of the JBI report (the report itself is not sent)
  note_context?: string[];    // printed rows of the template's notes sections
  instructions?: string;      // anything the person wants the AI to know
}

/** What the AI answered for one blank. */
export interface AiProposal {
  id: string;
  value: string | number | null;
  source: string;
  confidence: 'high' | 'medium' | 'low';
  note?: string;
}

export interface FillRunRow {
  id: string;
  job_id: string;
  status: FillStatus;
  error: string | null;
  result: AiProposal[] | null;
  created_at: string;
  finished_at: string | null;
}
