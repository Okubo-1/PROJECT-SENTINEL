import { z } from 'zod'
import { aiSuccessSchema } from './aiContracts.ts'
import { assembleSessionContext } from './aiSessions.ts'
import { answerPresentationSchema } from './aiEvidence.ts'
import { safetySnapshotSchema, type SafetyDataset, type SafetySnapshot } from './safetyIntelligenceContracts.ts'
import { buildSafetyLocationGuidance } from './safetyLocationGuidance.ts'
import { buildSafetyPlanningIndicators } from './safetyPlanningIndicators.ts'

export const copilotMetricKeys = ['risk', 'highRisk', 'nearMiss', 'category', 'resolution'] as const
export const copilotAnswerSchema = z.object({
  interpretation: z.string().trim().min(1).max(6_000),
  advice: z.string().trim().max(4_000),
  limitations: z.string().trim().min(1).max(3_000),
  metricKeys: z.array(z.enum(copilotMetricKeys)).max(5),
  sourceIds: z.array(z.string().min(1).max(100)).max(12),
  knowledgeSourceIds: z.array(z.string().min(1).max(100)).max(6),
}).strict()

// Explicit provider format complements local validation; it does not establish factual correctness.
export const copilotProviderFormat = {
  type: 'json_schema', name: 'safety_copilot_answer', strict: true,
  schema: {
    type: 'object', additionalProperties: false,
    properties: {
      interpretation: { type: 'string' }, advice: { type: 'string' }, limitations: { type: 'string' },
      metricKeys: { type: 'array', maxItems: 5, items: { type: 'string', enum: [...copilotMetricKeys] } },
      sourceIds: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 100 } },
      knowledgeSourceIds: { type: 'array', maxItems: 6, items: { type: 'string', minLength: 1, maxLength: 100 } },
    },
    required: ['interpretation', 'advice', 'limitations', 'metricKeys', 'sourceIds', 'knowledgeSourceIds'],
  },
} as const

const contextSchema = z.object({
  scope: safetySnapshotSchema.shape.scope,
  asOf: z.iso.datetime(), methodologyVersion: safetySnapshotSchema.shape.methodologyVersion,
  windows: safetySnapshotSchema.shape.windows, coverage: safetySnapshotSchema.shape.coverage,
  dataQuality: safetySnapshotSchema.shape.dataQuality,
  metrics: safetySnapshotSchema.shape.metrics,
  locations: safetySnapshotSchema.shape.locations,
  locationGuidance: z.array(z.object({ locationId: z.uuid(), recommendations: z.array(z.object({
    driver: z.string(), advice: z.string(), source: z.enum(['incident_counts', 'action_counts']),
  })) })),
  planningMetrics: z.array(z.object({
    siteId: z.uuid(), siteName: z.string(), state: z.enum(['available', 'incomplete']),
    openCritical: z.number().int().nonnegative(), openHigh: z.number().int().nonnegative(),
    nonOverdueUnfinishedActions: z.number().int().nonnegative(),
    criticalLinkedUnfinishedActions: z.number().int().nonnegative(), reasons: z.array(z.string()),
  })),
  evidence: z.array(safetySnapshotSchema.shape.evidence.element.extend({ key: z.string() })),
  limitations: z.array(z.string()), contextTruncated: z.boolean(),
}).strict()
export type CopilotGrounding = {
  context: z.infer<typeof contextSchema>; serialized: string; digest: string
  accessSources: Record<keyof SafetyDataset['rows'], string[]>
}
export const evidenceKey = (source: string, id: string) => `${source}:${id}`

export async function groundingDigest(dataset: SafetyDataset, snapshot: SafetySnapshot) {
  // A private digest, not source text, permits history only while its evidence/access remains unchanged.
  // Includes all authorized rows so loss of a source or a scope change cannot replay an old answer.
  const serialized = JSON.stringify({
    rows: dataset.rows, coverage: dataset.coverage, scope: snapshot.scope,
    filters: snapshot.filters, methodologyVersion: snapshot.methodologyVersion,
  })
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function buildCopilotGrounding(
  dataset: SafetyDataset, snapshot: SafetySnapshot, question: string,
): Promise<CopilotGrounding> {
  const terms = [...new Set(question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])]
  const relevance = (value: string) => terms.reduce((score, term) => score + Number(value.toLowerCase().includes(term)), 0)
  const locations = [...snapshot.locations].sort((a, b) => relevance(b.name) - relevance(a.name))
  const evidence = snapshot.evidence.map((item) => ({ ...item, key: evidenceKey(item.source, item.id) }))
    .sort((a, b) => relevance(`${b.label} ${b.excerpt}`) - relevance(`${a.label} ${a.excerpt}`))
  const guidance = buildSafetyLocationGuidance(snapshot)
  const planning = buildSafetyPlanningIndicators(snapshot)
  const context = contextSchema.parse({
    scope: snapshot.scope, asOf: snapshot.asOf, methodologyVersion: snapshot.methodologyVersion,
    windows: snapshot.windows, coverage: snapshot.coverage, dataQuality: snapshot.dataQuality,
    metrics: snapshot.metrics, locations: locations.slice(0, 12),
    locationGuidance: guidance.locations.map((item) => ({ locationId: item.location.id, recommendations: item.recommendations })),
    planningMetrics: planning.locations.slice(0, 12).map((item) => ({
      siteId: item.location.id, siteName: item.location.name, state: item.state,
      openCritical: item.openCritical, openHigh: item.openHigh,
      nonOverdueUnfinishedActions: item.nonOverdueUnfinishedActions,
      criticalLinkedUnfinishedActions: item.criticalLinkedUnfinishedActions, reasons: item.reasons,
    })),
    evidence: evidence.slice(0, 20),
    limitations: [
      ...snapshot.limitations,
      ...guidance.reasons,
      'Record examples/location lists may be bounded; an absent entity is not proof it does not exist.',
      'Procedure/regulatory/document knowledge is never part of operational data; when available it is supplied only as separately authorized approved QHSE knowledge excerpts.',
    ],
    contextTruncated: snapshot.evidenceTruncated || evidence.length > 20 || locations.length > 12 || planning.locations.length > 12,
  })
  const serialize = () => {
    const { userId: _userId, ...providerScope } = context.scope
    return JSON.stringify({ authorized_operational_context: { ...context, scope: providerScope } })
  }
  // Operational context uses at most 16k characters within a total 24k prompt/history/context budget.
  while (serialize().length > 16_000) {
    context.contextTruncated = true
    if (context.evidence.length) context.evidence.pop()
    else if (context.locations.length) context.locations.pop()
    else if (context.planningMetrics.length) context.planningMetrics.pop()
    else if (context.locationGuidance.length) context.locationGuidance.pop()
    else throw new Error('Operational context exceeds its fixed budget.')
  }
  // Advice cannot describe a location name omitted by trimming; retain only included locations.
  const ids = new Set(context.locations.map((item) => item.id))
  context.locationGuidance = context.locationGuidance.filter((item) => ids.has(item.locationId))
  context.planningMetrics = context.planningMetrics.filter((item) => ids.has(item.siteId))
  const { rows } = dataset
  const accessSources = {
    incidents: rows.incidents.map((row) => row.id), actions: rows.actions.map((row) => row.id),
    investigations: rows.investigations.map((row) => row.id), causes: rows.causes.map((row) => row.id),
    findings: rows.findings.map((row) => row.id), closures: rows.closures.map((row) => row.incident_id),
    sites: rows.sites.map((row) => row.id), facilities: rows.facilities.map((row) => row.id),
  }
  return { context, serialized: serialize(), digest: await groundingDigest(dataset, snapshot), accessSources }
}

const auditHistorySchema = z.array(z.object({
  request_id: z.uuid(),
  response_metadata: z.object({ grounding_digest: z.string().optional() }).passthrough(),
}))
const groundedHistorySchema = z.array(z.object({
  role: z.enum(['user', 'assistant']), content: z.string().min(1).max(32_000), request_id: z.uuid(),
})).max(20)

export function groundedHistoryRequestIds(history: unknown) {
  return [...new Set(groundedHistorySchema.parse(history).map((row) => row.request_id))]
}

export function assembleGroundedInput(
  history: unknown, audits: unknown, prompt: string, grounding: CopilotGrounding, knowledgeContext = '',
) {
  const proof = new Map(auditHistorySchema.parse(audits).map((row) => [row.request_id, row.response_metadata.grounding_digest]))
  const validatedHistory = groundedHistorySchema.parse(history)
  // Unproven foundation exchanges and changed-source answers are excluded as whole exchanges.
  const currentHistory = validatedHistory.filter((message) => proof.get(message.request_id) === grounding.digest)
  // Knowledge excerpts share the fixed 24k budget; history is trimmed first, never the prompt.
  const conversation = assembleSessionContext(currentHistory, prompt, 24_000 - grounding.serialized.length - knowledgeContext.length)
  return [
    { role: 'user' as const, content: grounding.serialized },
    ...(knowledgeContext ? [{ role: 'user' as const, content: knowledgeContext }] : []),
    ...conversation,
  ]
}

// `knowledge` carries only the chunk IDs actually supplied in this request plus a server status note.
export function validateCopilotAnswer(
  text: string, grounding: CopilotGrounding, knowledge: { sourceIds: string[]; note: string } = { sourceIds: [], note: '' },
) {
  let body: unknown
  try { body = JSON.parse(text) } catch { throw new Error('Invalid structured copilot output.') }
  const answer = copilotAnswerSchema.parse(body)
  // Models sometimes repeat an ID or place a supplied ID in the other list. Duplicates are collapsed and
  // each ID is routed by exact match against what this request actually supplied; anything else is rejected.
  answer.metricKeys = [...new Set(answer.metricKeys)]
  const supplied = new Set(knowledge.sourceIds)
  const evidence = new Map(grounding.context.evidence.map((item) => [item.key, item]))
  const cited = [...new Set([...answer.sourceIds, ...answer.knowledgeSourceIds])]
  if (cited.some((key) => !evidence.has(key) && !supplied.has(key))) throw new Error('Unknown copilot citation.')
  answer.sourceIds = cited.filter((key) => evidence.has(key))
  answer.knowledgeSourceIds = cited.filter((key) => supplied.has(key))
  if (answer.sourceIds.length > 12 || answer.knowledgeSourceIds.length > 6) throw new Error('Unknown copilot citation.')
  // The operational snapshot says procedure libraries are unavailable; that is false once approved knowledge was supplied.
  const base = supplied.size
    ? grounding.context.limitations.map((line) => line.replace('procedures, regulatory libraries and ', ''))
    : grounding.context.limitations
  const serverLimitations = knowledge.note ? [...base, knowledge.note] : base
  // Source IDs are accepted only from the exact evidence sent in this request, never a raw model URL/label.
  const citations: z.infer<typeof aiSuccessSchema>['citations'] = answer.sourceIds.map((key) => {
    const source = evidence.get(key)
    if (!source) throw new Error('Unknown copilot citation.')
    return { sourceType: 'operational_record', sourceId: key, label: source.label }
  })
  const observations = answer.metricKeys.map((key) =>
    `${key}: ${JSON.stringify(grounding.context.metrics[key])}`).join('\n')
  const rendered = [
    ...(observations ? [`Observed authorized data (${grounding.context.asOf}, UTC):\n${observations}`] : []),
    `AI interpretation (advisory):\n${answer.interpretation}`,
    ...(answer.advice ? [`AI recommendations (advisory):\n${answer.advice}`] : []),
    `Data limitations:\n${answer.limitations}`,
    `Server evidence scope: ${grounding.context.scope.visibility}; ${grounding.context.methodologyVersion}.\n${serverLimitations.join('\n')}`,
  ].join('\n\n')
  if (rendered.length > 32_000) throw new Error('Grounded answer exceeds the response contract.')
  const presentation = answerPresentationSchema.parse({
    observations: answer.metricKeys.map((key) => ({ key, value: JSON.stringify(grounding.context.metrics[key]) })),
    interpretation: answer.interpretation, advice: answer.advice, limitations: answer.limitations,
    serverLimitations,
  })
  return { text: rendered, citations, presentation, knowledgeSourceIds: answer.knowledgeSourceIds }
}
