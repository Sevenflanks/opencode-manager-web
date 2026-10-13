import assert from 'node:assert/strict'
import test from 'node:test'
import { selectSourceFiles, selectSourceRecords } from './source-selection.mjs'

const productFile = 'apps/manager/src/server.js'
const documentationFile = 'docs/coordinator.md'
const generatedAcceptanceReport = 'docs/coordinator-local-verification.md'
const record = (file, raw) => ({ file, bytes: raw.length, raw, canonical: raw })

test('generated acceptance report changes do not affect the frozen product source selection', () => {
  const original = [record(productFile, 'product-v1'), record(documentationFile, 'docs-v1'), record(generatedAcceptanceReport, 'report-v1')]
  const reportChanged = [record(productFile, 'product-v1'), record(documentationFile, 'docs-v1'), record(generatedAcceptanceReport, 'report-v2')]

  assert.deepEqual(selectSourceRecords(original).map(({ file }) => file), [productFile, documentationFile])
  assert.deepEqual(selectSourceFiles([productFile, documentationFile, generatedAcceptanceReport]), [productFile, documentationFile])
  assert.deepEqual(selectSourceRecords(reportChanged), selectSourceRecords(original))
})

test('a product source change remains in the frozen source selection', () => {
  const original = [record(productFile, 'product-v1'), record(generatedAcceptanceReport, 'report-v1')]
  const productChanged = [record(productFile, 'product-v2'), record(generatedAcceptanceReport, 'report-v1')]

  assert.deepEqual(selectSourceRecords(original).map(({ file }) => file), [productFile])
  assert.notDeepEqual(selectSourceRecords(productChanged), selectSourceRecords(original))
})
