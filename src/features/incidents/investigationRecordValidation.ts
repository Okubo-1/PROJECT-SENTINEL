export const fishboneHeadings = ['People', 'Process', 'Equipment', 'Environment', 'Management'] as const

export type RootCauseMethod = '5_whys' | 'fishbone' | 'fault_tree'
export type FishboneCause = { cause: string; is_root_cause: boolean }
export type FaultTreeCause = {
  cause: string
  gate: 'AND' | 'OR'
  is_root_cause: boolean
  children: FaultTreeCause[]
}

export type RootCauseBreakdown =
  | { method: '5_whys'; answers: string[] }
  | { method: 'fishbone'; categories: Record<(typeof fishboneHeadings)[number], FishboneCause[]> }
  | { method: 'fault_tree'; top_event: string; gate: 'AND' | 'OR'; causes: FaultTreeCause[] }

export function reportFileError(file: Pick<File, 'name' | 'type' | 'size'> | null | undefined): string | null {
  if (!file) return 'Attach an investigation report before closing.'
  const extension = file.name.toLowerCase().split('.').pop()
  const allowedTypes = new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ])
  const matchingType = extension === 'pdf' && file.type === 'application/pdf'
    || extension === 'doc' && file.type === 'application/msword'
    || extension === 'docx' && file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || file.name.toLowerCase() === 'evidence' && allowedTypes.has(file.type)
  if (!matchingType) {
    return 'The investigation report must be a PDF or Word document.'
  }
  if (file.size <= 0 || file.size > 10 * 1024 * 1024) return 'The investigation report must be smaller than 10 MB.'
  return null
}

export function rootCauseSummary(breakdown: RootCauseBreakdown): string {
  if (breakdown.method === '5_whys') {
    const answers = breakdown.answers.map((answer) => answer.trim())
    if (!answers.length || answers.length > 5 || answers.some((answer) => !answer)) {
      throw new Error('Complete each entered Why? answer (up to five).')
    }
    return answers[answers.length - 1]
  }
  if (breakdown.method === 'fishbone') {
    const causes = fishboneHeadings.flatMap((heading) => breakdown.categories[heading] || [])
      .filter((item) => item.is_root_cause && item.cause.trim())
      .map((item) => item.cause.trim())
    if (!causes.length) throw new Error('Mark at least one Fishbone cause as a root cause.')
    return causes.join('; ')
  }
  if (!breakdown.top_event.trim() || !breakdown.causes.length) {
    throw new Error('Add the Fault Tree top event and at least one cause.')
  }

  const rootCauses: string[] = []
  const visit = (causes: FaultTreeCause[]) => {
    for (const cause of causes) {
      if (!cause.cause.trim()) throw new Error('Complete every Fault Tree cause.')
      if (cause.children.length) {
        if (cause.is_root_cause) throw new Error('Only bottom-level Fault Tree causes can be root causes.')
        visit(cause.children)
      } else if (cause.is_root_cause) {
        rootCauses.push(cause.cause.trim())
      }
    }
  }
  visit(breakdown.causes)
  if (!rootCauses.length) throw new Error('Mark at least one bottom-level Fault Tree cause as a root cause.')
  return rootCauses.join('; ')
}

export function investigationCloseError(input: {
  immediateCauses: string
  breakdown: RootCauseBreakdown | null
  report: Pick<File, 'name' | 'type' | 'size'>
    | { name: string; mime_type: string; file_size: number }
    | { name: string; mimeType: string; fileSize: number }
    | null
}): string | null {
  if (!input.immediateCauses.trim()) return 'Immediate causes are required.'
  if (!input.breakdown) return 'Select and complete a root cause method.'
  try {
    rootCauseSummary(input.breakdown)
  } catch (error) {
    return error instanceof Error ? error.message : 'Complete the root cause analysis.'
  }

  if (!input.report) return 'Attach an investigation report before closing.'
  let file: Pick<File, 'name' | 'type' | 'size'>
  if ('mime_type' in input.report) {
    file = { name: input.report.name, type: input.report.mime_type, size: input.report.file_size }
  } else if ('mimeType' in input.report) {
    file = { name: input.report.name, type: input.report.mimeType, size: input.report.fileSize }
  } else {
    file = input.report
  }
  return reportFileError(file)
}
