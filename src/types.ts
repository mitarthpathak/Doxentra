export type ConceptCategory = 'Core Concept' | 'Main Topic' | 'Sub-topic' | 'Key Detail';

export interface Concept {
  id: string;
  title: string;
  description: string;
  category: ConceptCategory;
  tags: string[];
  isNew?: boolean;
  correlationNote?: string;
}

export interface PageProgress {
  pageCount: number;
  pagesCompleted: number;
  pageStart: number;
  pageEnd: number;
  chunkIndex: number;
  chunkCount: number;
}

export interface UploadStatus {
  id: string;
  fileName: string;
  progress: number;
  status: 'uploading' | 'analyzing' | 'completed' | 'failed';
  subtext?: string;
  stage?: string;
  startedAt?: number;
  stageStartedAt?: number;
  finishedAt?: number;
  uploadBytes?: number;
  size?: number;
  attempts?: number;
  pageProgress?: PageProgress;
  errorStage?: string;
  retryStage?: string;
  lastError?: string;
  error?: string;
  cached?: boolean;
  /** Image-quality warning measured before upload (blurry, dark …). */
  warning?: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  phone: string;
  age: number | null;
}

export type NodeType = 'major' | 'header' | 'sub-topic' | 'concept';

export interface GraphNode {
  id: string;
  label: string;
  type: NodeType;
  desc?: string;
  importance?: number;
  parentId?: string | null;
  /** Entity graph: what the node is (Person, Document …) and where it points. */
  caption?: string;
  documentId?: string;
  fieldKey?: string;
  severity?: 'error' | 'warning' | 'info';
}

export interface GraphEdge {
  source: string;
  target: string;
  label?: string;
  importance?: number;
  /** Entity graph: two values that disagree (a cross-document issue). */
  kind?: 'mismatch';
  severity?: 'error' | 'warning' | 'info';
  message?: string;
}

export interface RoadmapItem {
  number: string;
  title: string;
  status: 'completed' | 'in-progress' | 'locked' | string;
  desc: string;
}

export interface RelatedModuleItem {
  icon: string;
  title: string;
  desc: string;
}

export interface GraphMetadata {
  title?: string;
  description?: string;
  complexity?: number;
  category?: string;
  roadmap?: RoadmapItem[];
  relatedModules?: RelatedModuleItem[];
}

/** A knowledge map as used by the screens. */
export interface GraphData {
  issues?: CrossDocumentIssue[];
  id?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  metadata: GraphMetadata;
  filename: string;
  fallbackUsed?: boolean;
  /** 'entities': people, organisations and documents (GET /api/entity-graph). */
  kind?: 'concepts' | 'entities';
  stats?: { people: number; organisations: number; documents: number; fields: number; mismatches: number };
}

export type GraphMode = 'concepts' | 'entities';

/** Shape returned by /api/upload and by each item of /api/graphs. */
export interface SavedGraph {
  _id?: string;
  id?: string;
  filename: string;
  createdAt?: string;
  metadata?: GraphMetadata;
  graph: { nodes: any[]; edges: any[] };
  fallbackUsed?: boolean;
}

// ─── Document intelligence ──────────────────────────────────────────
export type ConfidenceBand = 'high' | 'medium' | 'low';

export interface ExtractedField {
  validation?: { passed: boolean | null; rule: string; rules: string[] };
  steps_applied?: string[];
  field?: string;
  candidates?: OcrCandidate[];
  agreement?: boolean;
  agreementState?: 'agreed' | 'uncertain';
  status?: 'accepted' | 'reprocessed' | 'needs_review';
  ocr?: {
    confidence: number;
    threshold: number;
    reasons: string[];
    majorityHint?: { value: string; engines: string[]; guaranteed: false };
    reprocess?: { attempted: boolean; steps?: string[]; region?: number[]; error?: string };
    manualReview?: { by: string; at: string; action: string };
  };
  key: string;
  label: string;
  type: string;
  format?: string;
  required: boolean;
  extra?: boolean;
  value: string | null;
  normalizedValue: string | number | string[] | null;
  modelConfidence: number;
  /** Legacy model/quote/validation score, retained for OCR cross-checked fields. */
  extractionConfidence?: number;
  confidence: number;
  confidenceBand?: ConfidenceBand;
  confidenceDetail?: {
    model: number;
    verification: number;
    validation: number;
    quoteFound?: boolean;
    source: 'text_layer' | 'ocr' | null;
    capped?: string[];
  };
  page: number | null;
  sourceQuote: string | null;
  /** Where the AI saw the value on a scan or photo: [ymin, xmin, ymax, xmax], 0-1000. */
  box?: number[];
  /** A Hindi (Devanagari) value in Latin letters. */
  transliteration?: string;
  /** Set once a person confirmed or corrected the value. */
  review?: { status: 'confirmed' | 'corrected'; by: string; at: string; original: { value: string | null } };
}

export interface OcrCandidate {
  sourceQuote?: string;
  engine: string;
  role?: 'extraction';
  value: string | null;
  confidence: number | null;
  confidenceGranularity?: 'line' | 'word' | 'character';
  page?: number | null;
  box?: number[] | null;
  attempt?: number;
  error?: string;
  lowConfidenceTokens?: { text: string; confidence: number | null; box?: number[] | null }[];
}

export interface OcrReviewItem {
  field: string;
  label: string;
  candidates: OcrCandidate[];
  confidence: number;
  threshold?: number;
  page: number | null;
  box: number[] | null;
  reasons: string[];
}

/** POST /api/documents/:id/translate. */
export interface DocumentTranslation {
  language: 'en' | 'hi';
  method: 'ai' | 'transliteration';
  model?: string;
  title: string;
  summary: string;
  fields: { key: string; label: string; original: string; value: string }[];
  pages: { page: number; text: string }[];
  createdAt: string;
}

export interface ReviewSummary {
  status: 'unreviewed' | 'in_review' | 'approved';
  reviewed: number;
  total: number;
  approvedAt?: string | null;
  approvedBy?: string | null;
}

/** One entry of a document's append-only review trail. */
export interface AuditEntry {
  at: string;
  by: string;
  action: 'confirm' | 'correct' | 'reset' | 'approve' | 'reopen' | 'twin_approve' | 'twin_needs_review';
  fieldKey?: string;
  label?: string;
  from?: string | null;
  to?: string | null;
  note?: string;
  approvalWithdrawn?: boolean;
  issuesBefore: IssueCounts;
  issuesAfter: IssueCounts;
  overallBefore: number | null;
  overallAfter: number | null;
}

export interface DocumentTwin {
  previousId: string;
  previousFilename: string;
  matchReason: string;
  fingerprint: string;
  changes: { key: string; label: string; before: TwinSource; after: TwinSource }[];
  conflicts: CrossDocumentIssue[];
  review: { status: 'approve' | 'needs_review'; by: string; at: string; note?: string } | null;
}

export interface TwinSource {
  documentId: string;
  filename: string;
  value: string | null;
  page: number | null;
  sourceQuote: string | null;
  box: number[] | null;
  hasFile: boolean;
}

export interface ExtractedEntity {
  type: string;
  value: string;
  page: number | null;
  sourceQuote: string | null;
  confidence?: number;
  confidenceBand?: ConfidenceBand;
}

export interface ExtractedTable {
  title: string;
  page: number | null;
  columns: string[];
  rows: string[][];
}

export interface DocumentIssue {
  /** Stable id of the validation rule (see GET /api/validation/rules). */
  rule?: string;
  severity: 'error' | 'warning' | 'info';
  type: 'missing' | 'inconsistent' | 'format' | 'low_confidence' | 'quality';
  fieldKeys: string[];
  message: string;
}

export interface IssueCounts {
  error: number;
  warning: number;
  info: number;
  total: number;
}

/** A document extraction as returned by /api/extract and /api/documents/:id. */
export interface DocumentResult {
  needs_review?: OcrReviewItem[];
  ocr?: { engines: string[]; pages: { page: number; engines: { engine: string; status: string; error?: string; confidenceGranularity?: string }[] }[];
    reprocessedFields: number; validationEnabled?: boolean; agreementIsGuarantee: false };
  processingMode?: 'deep' | 'privacy';
  /** Locally recognised text, with personal data masked by the server. */
  textByPage?: string[];
  id: string;
  filename: string;
  mimeType?: string;
  createdAt?: string;
  fallbackUsed?: boolean;
  docType: string;
  docTypeLabel: string;
  docTypeConfidence: number;
  docCategory?: string;
  docSubtype?: string | null;
  docSubtypeLabel?: string | null;
  /** Top 3 types, the chosen one first at docTypeConfidence. */
  typeCandidates?: TypeCandidate[];
  classification?: { modelConfidence: number; keywordShare: number | null; requiredCoverage: number; subtypeFrom: 'model' | 'keywords' | null };
  title: string;
  language?: string;
  summary: string;
  ocrUsed: boolean;
  textLayer?: string;
  pageCount: number;
  overallConfidence: number | null;
  fields: ExtractedField[];
  entities: ExtractedEntity[];
  tables: ExtractedTable[];
  issues: DocumentIssue[];
  issueCounts?: IssueCounts;
  hasGraph?: boolean;
  hasFile?: boolean;
  cached?: boolean;
  warning?: string;
  review?: ReviewSummary;
  /** The latest entries of the review trail, oldest first. */
  audit?: AuditEntry[];
  auditCount?: number;
  /** Translations kept on the document, by language ('en', 'hi'). */
  translations?: Record<string, DocumentTranslation>;
  /** GET /api/documents/:id?redact=1: personal data masked. */
  redacted?: boolean;
  redaction?: { fields: { key: string; label: string; kind: string }[]; kinds: Record<string, string> };
}

export interface TypeCandidate {
  docType: string;
  label: string;
  confidence: number;
}

/** A place in a document to show (a cited passage that is not a field). */
export interface SourceFocus {
  page: number | null;
  quote: string;
  label?: string;
}

/** Short form from GET /api/documents. */
export interface DocumentSummary {
  id: string;
  filename: string;
  mimeType?: string;
  createdAt?: string;
  fallbackUsed?: boolean;
  docType: string;
  docTypeLabel: string;
  docTypeConfidence: number;
  docCategory?: string;
  docSubtypeLabel?: string | null;
  title: string;
  summary: string;
  ocrUsed: boolean;
  pageCount: number;
  overallConfidence: number | null;
  fieldCount: number;
  issueCounts: IssueCounts;
  hasGraph: boolean;
  reviewStatus?: ReviewSummary['status'];
}

export interface SearchHit {
  documentId: string;
  filename: string;
  title: string;
  docType: string;
  docTypeLabel: string;
  overallConfidence: number | null;
  createdAt?: string;
  kind: 'field' | 'entity' | 'summary' | 'issue' | 'text' | 'title' | 'document';
  fieldKey?: string;
  label: string;
  value: string | null;
  snippet: string;
  highlights: [number, number][];
  page: number | null;
  confidence: number | null;
  sourceQuote?: string;
  score: number;
}

// ─── Ask the documents ──────────────────────────────────────────────
export interface AskCitation {
  n: number;
  documentId: string;
  title: string;
  filename: string;
  docTypeLabel: string;
  kind: 'profile' | 'field' | 'issue' | 'text';
  page: number | null;
  fieldKey?: string;
  quote: string;
  verified: boolean;
}

export interface AskTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: AskCitation[];
  followUps?: string[];
  mode?: 'ai' | 'extractive' | 'none';
  notice?: string;
  error?: boolean;
  scopeLabel?: string;
  pending?: boolean;
}

/** A conflict between two of the owner's documents (GET /api/crosscheck). */
export interface CrossDocumentIssue {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  type: 'cross_document';
  message: string;
  refs: { documentId: string; title: string; docType: string; filename: string; fieldKey: string | null; value: string | null }[];
}
