export type GenerationErrorKind = 'content_policy' | 'cancelled' | 'timeout'
export function classifyGenerationError(value: unknown): GenerationErrorKind | null
export function formatGenerationError(value: unknown, fallback?: string): string
export function getGenerationResponseError(payload: unknown): string | null
