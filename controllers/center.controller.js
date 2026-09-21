import { poolPromise } from "../config/db.js";



export const getAllCentres = async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .query("SELECT * FROM [ImmigrationCRM].[dbo].[Centres] ORDER BY created_at DESC");
    res.json(result.recordset);
  } catch (err) {
    console.error("Get All Centres Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};




export const getCentreById = async (req, res) => {
  const { id } = req.params;
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input("id", id)
      .query("SELECT * FROM [ImmigrationCRM].[dbo].[Centres] WHERE id = @id");

    if (result.recordset.length === 0) {
      return res.status(404).json({ message: "Centre not found" });
    }

    res.json(result.recordset[0]);
  } catch (err) {
    console.error("Get Centre By ID Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};




export const getCentreByCode = async (req, res) => {
  const { code } = req.params;
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input("code", code)
      .query("SELECT * FROM [ImmigrationCRM].[dbo].[Centres] WHERE centre_code = @code");

    if (result.recordset.length === 0) {
      return res.status(404).json({ message: "Centre not found" });
    }

    res.json(result.recordset[0]);
  } catch (err) {
    console.error("Get Centre By Code Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};




export const createCentre = async (req, res) => {
  const {
    centre_name,
    centre_code,
    description,
    email,
    phone,
    address_line1,
    address_line2,
    city,
    state,
    country,
    pincode,
    is_active = 1
  } = req.body;

  try {
    if (!centre_name || !centre_code || !email) {
      return res.status(400).json({ message: "centre_name, centre_code, and email are required" });
    }

    const pool = await poolPromise;

    // Check if centre_code already exists
    const existingCode = await pool.request()
      .input("code", centre_code)
      .query("SELECT id FROM Centres WHERE centre_code = @code");

    
    if (existingCode.recordset.length > 0) {
      return res.status(400).json({ message: "Centre code already exists" });
    }

    const result = await pool.request()
      .input("centre_name", centre_name)
      .input("centre_code", centre_code)
      .input("description", description || null)
      .input("email", email)
      .input("phone", phone || null)
      .input("address_line1", address_line1 || null)
      .input("address_line2", address_line2 || null)
      .input("city", city || null)
      .input("state", state || null)
      .input("country", country || null)
      .input("pincode", pincode || null)
      .input("is_active", is_active)
      .query(`
        INSERT INTO Centres (
          centre_name, centre_code, description, email, phone,
          address_line1, address_line2, city, state, country, pincode, is_active
        ) OUTPUT INSERTED.* 
        VALUES (
          @centre_name, @centre_code, @description, @email, @phone,
          @address_line1, @address_line2, @city, @state, @country, @pincode, @is_active
        )
      `);

    res.status(201).json({
      message: "Centre created successfully!",
      centre: result.recordset[0]
    });
  } catch (err) {
    console.error("Create Centre Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};




export const updateCentre = async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  try {
    const pool = await poolPromise;

    // Check if centre exists
    const existing = await pool.request()
      .input("id", id)
      .query("SELECT * FROM [ImmigrationCRM].[dbo].[Centres] WHERE id = @id");

    if (existing.recordset.length === 0) {
      return res.status(404).json({ message: "Centre not found" });
    }

    // Check centre_code uniqueness if changed
    if (updates.centre_code && updates.centre_code !== existing.recordset[0].centre_code) {
      const codeExists = await pool.request()
        .input("code", updates.centre_code)
        .query("SELECT id FROM [ImmigrationCRM].[dbo].[Centres] WHERE centre_code = @code AND id != @id")
        .input("id", id);
      
      if (codeExists.recordset.length > 0) {
        return res.status(400).json({ message: "Centre code already exists" });
      }
    }

    await pool.request()
      .input("id", id)
      .input("centre_name", updates.centre_name !== undefined ? updates.centre_name : existing.recordset[0].centre_name)
      .input("centre_code", updates.centre_code !== undefined ? updates.centre_code : existing.recordset[0].centre_code)
      .input("description", updates.description !== undefined ? updates.description : existing.recordset[0].description)
      .input("email", updates.email !== undefined ? updates.email : existing.recordset[0].email)
      .input("phone", updates.phone !== undefined ? updates.phone : existing.recordset[0].phone)
      .input("address_line1", updates.address_line1 !== undefined ? updates.address_line1 : existing.recordset[0].address_line1)
      .input("address_line2", updates.address_line2 !== undefined ? updates.address_line2 : existing.recordset[0].address_line2)
      .input("city", updates.city !== undefined ? updates.city : existing.recordset[0].city)
      .input("state", updates.state !== undefined ? updates.state : existing.recordset[0].state)
      .input("country", updates.country !== undefined ? updates.country : existing.recordset[0].country)
      .input("pincode", updates.pincode !== undefined ? updates.pincode : existing.recordset[0].pincode)
      .input("is_active", updates.is_active !== undefined ? updates.is_active : existing.recordset[0].is_active)
      .query(`
        UPDATE [CRM].[dbo].[Centres] SET
          centre_name = @centre_name,
          centre_code = @centre_code,
          description = @description,
          email = @email,
          phone = @phone,
          address_line1 = @address_line1,
          address_line2 = @address_line2,
          city = @city,
          state = @state,
          country = @country,
          pincode = @pincode,
          is_active = @is_active,
          updated_at = GETDATE()
        WHERE id = @id
      `);

    // Return updated centre
    const updated = await pool.request()
      .input("id", id)
      .query("SELECT * FROM [CRM].[dbo].[Centres] WHERE id = @id");

    res.json({
      message: "Centre updated successfully!",
      centre: updated.recordset[0]
    });
  } catch (err) {
    console.error("Update Centre Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};




export const deleteCentre = async (req, res) => {
  const { id } = req.params;
  try {
    const pool = await poolPromise;

    // Check if centre exists
    const existing = await pool.request()
      .input("id", id)
      .query("SELECT id FROM [CRM].[dbo].[Centres] WHERE id = @id");

    if (existing.recordset.length === 0) {
      return res.status(404).json({ message: "Centre not found" });
    }

    await pool.request()
      .input("id", id)
      .query(`
        UPDATE [CRM].[dbo].[Centres] 
        SET is_active = 0, updated_at = GETDATE()
        WHERE id = @id
      `);

    res.json({ message: "Centre soft deleted successfully!" });
  } catch (err) {
    console.error("Delete Centre Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};

