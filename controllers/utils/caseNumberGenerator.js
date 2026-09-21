import { sql } from '../../config/db.js';

/**
 * Generates a unique case reference (e.g., CAN-202608-0042)
 * @param {sql.Transaction} transaction 
 * @param {string} centerCode 
 * @returns {Promise<string>}
 */
export const generateCaseNumber = async (transaction, centerCode = 'HQ') => {
  const date = new Date();
  const yearMonth = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;
  const prefix = `CAN-${centerCode.toUpperCase()}-${yearMonth}`;

  const request = new sql.Request(transaction);
  const result = await request
    .input('pattern', sql.VarChar, `${prefix}-%`)
    .query(`
      SELECT TOP 1 case_number 
      FROM ImmigrationCases WITH (UPDLOCK, HOLDLOCK)
      WHERE case_number LIKE @pattern 
      ORDER BY case_id DESC
    `);

  let nextSequence = 1;
  if (result.recordset.length > 0) {
    const lastCaseNumber = result.recordset[0].case_number;
    const parts = lastCaseNumber.split('-');
    const lastSeq = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(lastSeq)) {
      nextSequence = lastSeq + 1;
    }
  }

  return `${prefix}-${String(nextSequence).padStart(4, '0')}`;
}

