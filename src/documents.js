// The static product brochures sent as a follow-up to a quote.
//
// Callers pass a logical name (`copayment` / `deductible`), never a path or
// filename — so n8n can't be coaxed into reading arbitrary files off disk.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'documents')

// `file` is what's on disk; `fileName` is what the client sees in WhatsApp.
// The on-disk names carry both the product and the plan type, so mixing up
// HealthAssured and HealthInsured takes real effort.
export const DOCUMENTS = {
  // Age band 0-40, 15% co-payment.
  copayment: {
    file: 'health-assured-copayment.pdf',
    fileName: 'Allianz HealthAssured Brochure.pdf',
  },
  // Age bands 41-60 (RM5,000) and 61-70 (RM10,000) — one brochure covers both.
  deductible: {
    file: 'health-insured-deductible.pdf',
    fileName: 'Allianz HealthInsured Brochure.pdf',
  },
}

/**
 * Loads every brochure into memory up front (~6MB of base64 for the two
 * current files). Reading at startup means a deploy that forgot to ship the
 * PDFs fails immediately instead of on the first real client send.
 */
export function createDocumentStore(dir = DEFAULT_DIR) {
  const loaded = new Map()
  for (const [name, { file, fileName }] of Object.entries(DOCUMENTS)) {
    loaded.set(name, {
      fileName,
      base64: readFileSync(join(dir, file)).toString('base64'),
    })
  }

  return {
    names: () => [...loaded.keys()],
    /** @returns {{ fileName: string, base64: string } | null} */
    get: (name) => loaded.get(name) ?? null,
  }
}
