/**
 * Boucle agent et vérification des citations (serveur). Importer depuis
 * '@/lib/agent'.
 */
export { runAgent, parseFinalAnswer, DEFAULT_AGENT_LIMITS } from './run-agent';
export type { AgentHistoryMessage, AgentLimits, AgentResult, AgentStepEvent, AgentToolTrace, RunAgentParams } from './run-agent';
export { verifyAnswer, inspectAnswer, checkCitation, quoteLongEnough, looksLikeInjection, MIN_QUOTE_CHARS, MIN_QUOTE_TOKENS } from './verify';
export type { CitationIssue, CitationIssueReason, VerificationReport, VerifyOptions } from './verify';
export { RetrievedChunks, EvidenceLog, DEFAULT_EVIDENCE_LIMITS } from './evidence';
export type { RetrievedChunk, EvidenceLimits } from './evidence';
export { AGENT_SYSTEM_PROMPT, composePrompt, repairPrompt, citationFixPrompt, FINAL_ANSWER_FORMAT_NAME } from './prompt';
export { AgentError, toChatError, isAbortError } from './errors';
export type { AgentErrorCode } from './errors';
