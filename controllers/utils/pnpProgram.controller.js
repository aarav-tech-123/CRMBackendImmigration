import { sql, poolPromise } from "../../config/db.js";
import { parsePositiveInt, paginationParams } from "../../helpers/parsers.js";

const cleanString = (value) => (typeof value === "string" ? value.trim() : value);

// ---------------------------------------------------------------------------
// GET /?province_code=&search=&is_active=&page=&pageSize=
// ---------------------------------------------------------------------------
export const getPnpPrograms = async (req, res) => {
  const { page, pageSize, offset } = paginationParams(req);
  const provinceCode = req.query.province_code ? String(req.query.province_code).trim().toUpperCase() : null;
  const search = req.query.search ? `%${String(req.query.search).trim()}%` : null;
  const isActive = req.query.is_active === undefined ? null : req.query.is_active === "true" || req.query.is_active === "1" ? 1 : 0;

  try {
    const pool = await poolPromise;
    const buildRequest = () =>
      pool
        .request()
        .input("province_code", sql.VarChar(5), provinceCode)
        .input("search", sql.NVarChar(255), search)
        .input("is_active", sql.Bit, isActive);

    const where = `
      WHERE (@province_code IS NULL OR province_code = @province_code)
        AND (@is_active IS NULL OR is_active = @is_active)
        AND (@search IS NULL OR program_name LIKE @search OR province_name LIKE @search OR stream_type LIKE @search)
    `;

    const [dataResult, countResult] = await Promise.all([
      buildRequest()
        .input("offset", sql.Int, offset)
        .input("pageSize", sql.Int, pageSize)
        .query(`
          SELECT * FROM PNPPrograms ${where}
          ORDER BY province_name ASC, program_name ASC
          OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;
        `),
      buildRequest().query(`SELECT COUNT(*) AS total FROM PNPPrograms ${where};`),
    ]);

    return res.status(200).json({
      success: true,
      page,
      pageSize,
      total: countResult.recordset[0].total,
      programs: dataResult.recordset,
    });
  } catch (err) {
    console.error("[getPnpPrograms] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch PNP programs." });
  }
};

// ---------------------------------------------------------------------------
// GET /:pnpProgramId
// ---------------------------------------------------------------------------
export const getPnpProgramById = async (req, res) => {
  const pnpProgramId = parsePositiveInt(req.params.pnpProgramId);
  if (!pnpProgramId) {
    return res.status(400).json({ success: false, message: "A valid pnpProgramId is required." });
  }

  try {
    const pool = await poolPromise;
    const result = await pool
      .request()
      .input("pnp_program_id", sql.Int, pnpProgramId)
      .query("SELECT * FROM PNPPrograms WHERE pnp_program_id = @pnp_program_id");
    if (result.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "PNP program not found." });
    }
    return res.status(200).json({ success: true, data: result.recordset[0] });
  } catch (err) {
    console.error("[getPnpProgramById] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch PNP program." });
  }
};

// ---------------------------------------------------------------------------
// POST /
// ---------------------------------------------------------------------------
export const createPnpProgram = async (req, res) => {
  const { province_code, province_name, program_name, stream_type, description, is_active } = req.body || {};

  const provinceCode = cleanString(province_code)?.toUpperCase();
  const provinceName = cleanString(province_name);
  const programName = cleanString(program_name);

  if (!provinceCode || !provinceName || !programName) {
    return res.status(400).json({ success: false, message: "province_code, province_name and program_name are required." });
  }
  if (provinceCode.length > 5) {
    return res.status(400).json({ success: false, message: "province_code must be at most 5 characters." });
  }

  try {
    const pool = await poolPromise;

    const duplicate = await pool
      .request()
      .input("province_code", sql.VarChar(5), provinceCode)
      .input("program_name", sql.NVarChar(255), programName)
      .query("SELECT pnp_program_id FROM PNPPrograms WHERE province_code = @province_code AND program_name = @program_name");
    if (duplicate.recordset.length > 0) {
      return res.status(409).json({ success: false, message: "This PNP program already exists for the province." });
    }

    const result = await pool
      .request()
      .input("province_code", sql.VarChar(5), provinceCode)
      .input("province_name", sql.NVarChar(100), provinceName)
      .input("program_name", sql.NVarChar(255), programName)
      .input("stream_type", sql.NVarChar(100), cleanString(stream_type) || null)
      .input("description", sql.NVarChar(sql.MAX), description || null)
      .input("is_active", sql.Bit, is_active === false ? 0 : 1)
      .input("created_by", sql.Int, req.user?.id ?? null)
      .query(`
        INSERT INTO PNPPrograms
          (province_code, province_name, program_name, stream_type, description, is_active, created_by, created_at, updated_at)
        OUTPUT INSERTED.*
        VALUES
          (@province_code, @province_name, @program_name, @stream_type, @description, @is_active, @created_by, GETDATE(), GETDATE())
      `);

    return res.status(201).json({ success: true, message: "PNP program created successfully.", data: result.recordset[0] });
  } catch (err) {
    console.error("[createPnpProgram] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to create PNP program." });
  }
};

// ---------------------------------------------------------------------------
// PATCH /:pnpProgramId
// ---------------------------------------------------------------------------
export const updatePnpProgram = async (req, res) => {
  const pnpProgramId = parsePositiveInt(req.params.pnpProgramId);
  if (!pnpProgramId) {
    return res.status(400).json({ success: false, message: "A valid pnpProgramId is required." });
  }
  const { province_code, province_name, program_name, stream_type, description, is_active } = req.body || {};

  try {
    const pool = await poolPromise;

    const existingResult = await pool
      .request()
      .input("pnp_program_id", sql.Int, pnpProgramId)
      .query("SELECT * FROM PNPPrograms WHERE pnp_program_id = @pnp_program_id");
    if (existingResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "PNP program not found." });
    }
    const existing = existingResult.recordset[0];

    const provinceCode = province_code !== undefined ? cleanString(province_code)?.toUpperCase() : existing.province_code;
    const provinceName = province_name !== undefined ? cleanString(province_name) : existing.province_name;
    const programName = program_name !== undefined ? cleanString(program_name) : existing.program_name;

    if (!provinceCode || !provinceName || !programName) {
      return res.status(400).json({ success: false, message: "province_code, province_name and program_name cannot be empty." });
    }
    if (provinceCode.length > 5) {
      return res.status(400).json({ success: false, message: "province_code must be at most 5 characters." });
    }

    const duplicate = await pool
      .request()
      .input("pnp_program_id", sql.Int, pnpProgramId)
      .input("province_code", sql.VarChar(5), provinceCode)
      .input("program_name", sql.NVarChar(255), programName)
      .query(`
        SELECT pnp_program_id FROM PNPPrograms
        WHERE province_code = @province_code AND program_name = @program_name AND pnp_program_id <> @pnp_program_id
      `);
    if (duplicate.recordset.length > 0) {
      return res.status(409).json({ success: false, message: "This PNP program already exists for the province." });
    }

    const result = await pool
      .request()
      .input("pnp_program_id", sql.Int, pnpProgramId)
      .input("province_code", sql.VarChar(5), provinceCode)
      .input("province_name", sql.NVarChar(100), provinceName)
      .input("program_name", sql.NVarChar(255), programName)
      .input("stream_type", sql.NVarChar(100), stream_type !== undefined ? cleanString(stream_type) || null : existing.stream_type)
      .input("description", sql.NVarChar(sql.MAX), description !== undefined ? description : existing.description)
      .input("is_active", sql.Bit, is_active !== undefined ? (is_active ? 1 : 0) : existing.is_active)
      .query(`
        UPDATE PNPPrograms
        SET province_code = @province_code,
            province_name = @province_name,
            program_name = @program_name,
            stream_type = @stream_type,
            description = @description,
            is_active = @is_active,
            updated_at = GETDATE()
        OUTPUT INSERTED.*
        WHERE pnp_program_id = @pnp_program_id
      `);

    return res.status(200).json({ success: true, message: "PNP program updated successfully.", data: result.recordset[0] });
  } catch (err) {
    console.error("[updatePnpProgram] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to update PNP program." });
  }
};

// ---------------------------------------------------------------------------
// DELETE /:pnpProgramId  (blocked while any case uses it — deactivate instead)
// ---------------------------------------------------------------------------
export const deletePnpProgram = async (req, res) => {
  const pnpProgramId = parsePositiveInt(req.params.pnpProgramId);
  if (!pnpProgramId) {
    return res.status(400).json({ success: false, message: "A valid pnpProgramId is required." });
  }

  try {
    const pool = await poolPromise;

    const existing = await pool
      .request()
      .input("pnp_program_id", sql.Int, pnpProgramId)
      .query("SELECT pnp_program_id FROM PNPPrograms WHERE pnp_program_id = @pnp_program_id");
    if (existing.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "PNP program not found." });
    }

    const inUse = await pool
      .request()
      .input("pnp_program_id", sql.Int, pnpProgramId)
      .query("SELECT TOP 1 case_pnp_id FROM CasePNPPrograms WHERE pnp_program_id = @pnp_program_id");
    if (inUse.recordset.length > 0) {
      return res.status(409).json({
        success: false,
        message: "This PNP program is linked to one or more cases. Set is_active to false instead of deleting it.",
      });
    }

    await pool
      .request()
      .input("pnp_program_id", sql.Int, pnpProgramId)
      .query("DELETE FROM PNPPrograms WHERE pnp_program_id = @pnp_program_id");

    return res.status(200).json({ success: true, message: "PNP program deleted successfully." });
  } catch (err) {
    console.error("[deletePnpProgram] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to delete PNP program." });
  }
};
