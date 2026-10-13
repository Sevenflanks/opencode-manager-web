export const generatedAcceptanceReport = 'docs/coordinator-local-verification.md'

export function selectSourceRecords(records) {
  return records.filter(({ file }) => file !== generatedAcceptanceReport)
}

export function selectSourceFiles(files) {
  return files.filter(file => file !== generatedAcceptanceReport)
}
