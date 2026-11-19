import assert from 'node:assert/strict'
import test from 'node:test'

import {
  investigationCloseError,
  reportFileError,
  rootCauseSummary,
  type RootCauseBreakdown,
} from './investigationRecordValidation.ts'

test('5 Whys uses the last investigator-entered answer as the root cause', () => {
  const record: RootCauseBreakdown = {
    method: '5_whys',
    answers: ['Why 1', 'Why 2'],
  }
  assert.equal(rootCauseSummary(record), 'Why 2')
})

test('Fishbone saves only investigator-marked root causes', () => {
  const record: RootCauseBreakdown = {
    method: 'fishbone',
    categories: {
      People: [{ cause: 'Fatigue', is_root_cause: true }],
      Process: [],
      Equipment: [],
      Environment: [],
      Management: [],
    },
  }
  assert.equal(rootCauseSummary(record), 'Fatigue')
})

test('Fault Tree saves marked bottom-level causes', () => {
  const record: RootCauseBreakdown = {
    method: 'fault_tree',
    top_event: 'Top event',
    gate: 'OR',
    causes: [{
      cause: 'Branch',
      gate: 'AND',
      is_root_cause: false,
      children: [{ cause: 'Failed control', gate: 'OR', is_root_cause: true, children: [] }],
    }],
  }
  assert.equal(rootCauseSummary(record), 'Failed control')
})

test('closing requires immediate causes, completed root cause, and report', () => {
  const empty = { immediateCauses: '', breakdown: null, report: null }
  assert.equal(investigationCloseError(empty), 'Immediate causes are required.')
})

test('closing rejects missing root cause and missing report', () => {
  const breakdown: RootCauseBreakdown = { method: '5_whys', answers: ['Cause'] }
  assert.equal(investigationCloseError({
    immediateCauses: 'Immediate cause',
    breakdown: null,
    report: { name: 'report.pdf', type: 'application/pdf', size: 12 },
  }), 'Select and complete a root cause method.')
  assert.equal(investigationCloseError({
    immediateCauses: 'Immediate cause',
    breakdown,
    report: null,
  }), 'Attach an investigation report before closing.')
})

test('investigation reports must be PDF or Word documents', () => {
  assert.equal(reportFileError({ name: 'report.pdf', type: 'application/pdf', size: 12 }), null)
  assert.equal(reportFileError({ name: 'report.exe', type: 'application/octet-stream', size: 12 }), 'The investigation report must be a PDF or Word document.')
  assert.equal(reportFileError({ name: 'report.pdf', type: 'application/msword', size: 12 }), 'The investigation report must be a PDF or Word document.')
  assert.equal(investigationCloseError({
    immediateCauses: 'Immediate cause',
    breakdown: { method: '5_whys', answers: ['Root cause'] },
    report: { name: 'report.pdf', type: 'text/plain', size: 12 },
  }), 'The investigation report must be a PDF or Word document.')
})
