import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import ExcelJS from 'exceljs'
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx'

import { effectiveIncidentSeverityLabel } from '../../../supabase/functions/_shared/incidentReportFilters'
import { buildExportFileName, downloadExport } from '../../lib/download'
import type { IncidentSummary } from './incidentTypes'
import { formatDate, formatDateTime, label } from './incidentFormatting'

export type ExportFormat = 'xlsx' | 'pdf' | 'docx'

export type IncidentExportRow = {
  reference: string
  title: string
  reportType: string
  category: string
  severity: string
  status: string
  site: string
  department: string
  occurredAt: string
  submittedAt: string
  reporter: string
  location: string
}

export function exportRows(items: IncidentSummary[], sites: Array<{ id: string; name: string }>): IncidentExportRow[] {
  return items.map((incident) => ({
    reference: incident.referenceNumber,
    title: incident.title,
    reportType: label(incident.reportType),
    category: incident.incidentCategory || 'Not set',
    severity: effectiveIncidentSeverityLabel(incident.severity, incident.potentialSeverity),
    status: label(incident.status),
    site: sites.find((site) => site.id === incident.siteId)?.name || 'Not set',
    department: incident.department || 'Not set',
    occurredAt: formatDate(incident.occurredAt),
    submittedAt: formatDateTime(incident.reportedAt),
    reporter: incident.isAnonymous ? 'Anonymous reporter' : incident.createdBy,
    location: incident.location || 'Not set',
  }))
}

function exportCsvLikeRows(rows: IncidentExportRow[]) {
  return rows.map((row) => [row.reference, row.title, row.reportType, row.category, row.severity, row.status, row.site, row.department, row.occurredAt, row.submittedAt, row.reporter, row.location])
}

export function exportPdf(rows: IncidentExportRow[], generatedAt: Date, administrator: string) {
  const pdf = new jsPDF({ orientation: 'landscape' })
  pdf.setTextColor('#0f172a')
  pdf.setFontSize(18)
  pdf.text('SentinelQHSE', 14, 16)
  pdf.setFontSize(14)
  pdf.text('Incident Management Register', 14, 25)
  pdf.setFontSize(9)
  pdf.setTextColor('#475569')
  pdf.text('Filtered incident records currently visible to the authenticated user.', 14, 33)
  pdf.text(`Exported: ${generatedAt.toLocaleString()} | Records: ${rows.length}`, 14, 40)
  autoTable(pdf, {
    startY: 48,
    head: [['Reference', 'Title', 'Type', 'Category', 'Severity', 'Status', 'Site', 'Department', 'Occurred', 'Submitted', 'Reporter', 'Location']],
    body: exportCsvLikeRows(rows),
    styles: { fontSize: 7, cellPadding: 2 },
    headStyles: { fillColor: [15, 74, 62] },
  })
  const finalY = (pdf as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 48
  pdf.setTextColor('#0f172a')
  pdf.setFontSize(9)
  pdf.text('AUTHORIZED EXPORT — ADMINISTRATOR SIGN-OFF', 14, finalY + 15)
  pdf.setFontSize(8)
  pdf.text(`Authorized / Exported By: ${administrator}`, 14, finalY + 22)
  pdf.text(`Date and Time of Export: ${generatedAt.toLocaleString()}`, 14, finalY + 29)
  pdf.save(buildExportFileName('Incident_Management', 'pdf', generatedAt))
}

export async function exportExcel(rows: IncidentExportRow[], generatedAt: Date, administrator: string) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Incident Register')
  sheet.mergeCells('A1:L1')
  sheet.getCell('A1').value = 'SentinelQHSE — Incident Management Register'
  sheet.getCell('A1').font = { bold: true, size: 16, color: { argb: '0F172A' } }
  sheet.mergeCells('A2:L2')
  sheet.getCell('A2').value = 'Filtered incident records currently visible to the authenticated user.'
  sheet.getCell('A3').value = 'Exported'
  sheet.getCell('B3').value = generatedAt.toLocaleString()
  sheet.getCell('D3').value = 'Records'
  sheet.getCell('E3').value = rows.length
  const header = sheet.addRow(['Reference', 'Title', 'Type', 'Category', 'Severity', 'Status', 'Site', 'Department', 'Occurred', 'Submitted', 'Reporter', 'Location'])
  header.font = { bold: true, color: { argb: 'FFFFFF' } }
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '0F4A3E' } }
  rows.forEach((row) => sheet.addRow(exportCsvLikeRows([row])[0]))
  sheet.addRow([])
  sheet.addRow(['AUTHORIZED EXPORT — ADMINISTRATOR SIGN-OFF'])
  sheet.addRow(['Authorized / Exported By', administrator])
  sheet.addRow(['Date and Time of Export', generatedAt.toLocaleString()])
  sheet.columns = [{ width: 18 }, { width: 30 }, { width: 18 }, { width: 22 }, { width: 14 }, { width: 18 }, { width: 22 }, { width: 20 }, { width: 16 }, { width: 24 }, { width: 28 }, { width: 24 }]
  sheet.eachRow((row) => row.eachCell((cell) => { cell.alignment = { ...cell.alignment, vertical: 'top', wrapText: true } }))
  const buffer = await workbook.xlsx.writeBuffer()
  downloadExport(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), buildExportFileName('Incident_Management', 'xlsx', generatedAt))
}

export async function exportWord(rows: IncidentExportRow[], generatedAt: Date, administrator: string) {
  const headers = ['Reference', 'Title', 'Type', 'Category', 'Severity', 'Status', 'Site', 'Department', 'Occurred', 'Submitted', 'Reporter', 'Location']
  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: headers.map((value) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: value, bold: true })] })] })) }),
      ...rows.map((row) => new TableRow({ children: exportCsvLikeRows([row])[0].map((value) => new TableCell({ children: [new Paragraph(value)] })) })),
    ],
  })
  const document = new Document({ sections: [{ children: [
    new Paragraph({ text: 'SentinelQHSE', heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ text: 'Incident Management Register', heading: HeadingLevel.HEADING_2 }),
    new Paragraph({ text: 'Filtered incident records currently visible to the authenticated user.' }),
    new Paragraph({ text: `Exported: ${generatedAt.toLocaleString()} | Records: ${rows.length}` }),
    table,
    new Paragraph({ text: 'AUTHORIZED EXPORT — ADMINISTRATOR SIGN-OFF', heading: HeadingLevel.HEADING_2, spacing: { before: 360 } }),
    new Paragraph({ text: `Authorized / Exported By: ${administrator}` }),
    new Paragraph({ text: `Date and Time of Export: ${generatedAt.toLocaleString()}` }),
  ] }] })
  const buffer = await Packer.toBlob(document)
  downloadExport(buffer, buildExportFileName('Incident_Management', 'docx', generatedAt))
}
