import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";
// import crypto from "crypto";
import { poolPromise } from "../config/db.js";
import dotenv from "dotenv";
dotenv.config();


export const getUser = async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query("SELECT * FROM Users ORDER BY id DESC");
    res.json(result.recordset);
  } catch (err) {
    console.error("Get Users Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};



export const register = async (req, res) => {
  const { name, email, password, role, center_code } = req.body;

  try {
    if (!name || !email || !password || !role || !center_code) {
      return res.status(400).json({ message: "All fields are required." });
    }

    // Validate name
    if (name.length < 2 || name.length > 50) {
      return res.status(400).json({ message: "Name must be 2–50 characters long." });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: "Invalid email format." });
    }

    // Validate password (at least 6 chars)
    if (password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters long." });
    }
    // Check if email already exists
    
    const pool = await poolPromise;
    const existingUser = await pool
      .request()
      .input("email", email)
      .query("SELECT id FROM Users WHERE email = @email");

    if (existingUser.recordset.length > 0) {
      return res.status(400).json({ message: "Email already registered." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await pool.request()
      .input("name", name)
      .input("email", email)
      .input("password", hashedPassword)
      .input("role", role)
      .input("center_code", center_code)
      .query(`
        INSERT INTO Users (name, email, password, role, center_code)
        VALUES (@name, @email, @password, @role, @center_code)
      `);

    res.json({ message: "User registered successfully!" });

  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};



export const login = async (req, res) => {
  const { email, password } = req.body;
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input("email", email)
      .query("SELECT * FROM Users WHERE email = @email");

    const user = result.recordset[0];
    if (!user) return res.status(400).json({ message: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: "Invalid credentials" });

    const token = jwt.sign(
      { id: user.id, role: user.role, center_code: user.center_code },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ token, user });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};


const otpExpiryMinutes = 5 // OTP valid for 10 minutes




export const forgotPassword = async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: "Email is required." });
  }

  try {
    const pool = await poolPromise;

    // Check if user exists
    const userResult = await pool.request()
      .input("email", email)
      .query("SELECT id FROM Users WHERE email = @email");

    if (userResult.recordset.length === 0) {
      return res.status(400).json({ message: "Email not registered." });
    }

    const userId = userResult.recordset[0].id;

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Save OTP in DB with expiry (you may add otp & otp_expiry columns in Users table)
    const otpExpiry = new Date(Date.now() + otpExpiryMinutes * 60000); // 10 minutes from now
    await pool.request()
      .input("otp", otp)
      .input("otp_expiry", otpExpiry)
      .input("id", userId)
      .query("UPDATE Users SET otp = @otp, otp_expiry = @otp_expiry WHERE id = @id");

    // Send OTP via email
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      auth: {
        user: "aditya.gupin1950@gmail.com",
        pass: "jrehsbhvkmjoajgb",
      },
    });

    await transporter.sendMail({
      from: '"Aaravtech Services" aditya.gupin1950@gmail.com',
      to: email,
      subject: "Your OTP for Password Reset",
      text: `Your OTP is ${otp}. It will expire in ${otpExpiryMinutes} minutes.`,
    });

    res.json({ message: "OTP sent to your email." });

  } catch (err) {
    console.error("Forgot password error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const resetPassword = async (req, res) => {
  const { email, otp, newPassword } = req.body;

  if (!email || !otp || !newPassword) {
    return res.status(400).json({ message: "All fields are required." });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ message: "Password must be at least 6 characters long." });
  }

  try {
    const pool = await poolPromise;

    // Fetch user and OTP info
    const userResult = await pool.request()
      .input("email", email)
      .query("SELECT id, otp, otp_expiry FROM Users WHERE email = @email");

    if (userResult.recordset.length === 0) {
      return res.status(400).json({ message: "Email not registered." });
    }

    const user = userResult.recordset[0];

    // Check OTP validity
    if (user.otp !== otp) {
      return res.status(400).json({ message: "Invalid OTP." });
    }

    if (new Date() > new Date(user.otp_expiry)) {
      return res.status(400).json({ message: "OTP expired." });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password and remove OTP
    await pool.request()
      .input("password", hashedPassword)
      .input("id", user.id)
      .query("UPDATE Users SET password = @password, otp = NULL, otp_expiry = NULL WHERE id = @id");

    res.json({ message: "Password updated successfully!" });

  } catch (err) {
    console.error("Reset password error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const getProfile = async (req, res) => {
  const userId = req.user.id;
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input("id", userId)
      .query("SELECT id, name, email, role, center_code FROM Users WHERE id = @id");
    const user = result.recordset[0];
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.json(user);
  } catch (err) {
    console.error("Get profile error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};


export const updateProfile = async(req, res) => {
  const userId = req.params.id;
  const { name, email, role, center_code } = req.body;

  try {
    const pool = await poolPromise;
    await pool.request()
      .input("name", name)
      .input("email", email)
      .input("role", role)
      .input("center_code", center_code)
      .input("id", userId)
      .query(`
        UPDATE Users
        SET name = @name, email = @email, role = @role, center_code = @center_code
        WHERE id = @id
      `);

    res.json({ message: "Profile updated successfully!" });
  } catch (err) {
    console.error("Update profile error:", err);
    res.status(500).json({ message: "Server Error" });


    
  }
}









































// import bcrypt from "bcryptjs";
// import jwt from "jsonwebtoken";
// import nodemailer from "nodemailer";
// import { poolPromise } from "../config/db.js";
// import dotenv from "dotenv";
// dotenv.config();

// // ─── Token Helpers ────────────────────────────────────────────────────────────

// /**
//  * Generates a short-lived access token (15 minutes).
//  */
// const generateAccessToken = (user) =>
//   jwt.sign(
//     { id: user.id, role: user.role },
//     process.env.JWT_SECRET,
//     { expiresIn: "15m" }
//   );

// /**
//  * Generates a long-lived refresh token (7 days).
//  */
// const generateRefreshToken = (user) =>
//   jwt.sign(
//     { id: user.id, role: user.role },
//     process.env.JWT_REFRESH_SECRET,
//     { expiresIn: "7d" }
//   );

// // ─── Controllers ──────────────────────────────────────────────────────────────

// /**
//  * @swagger
//  * /auth/users:
//  *   get:
//  *     summary: Get all users
//  *     tags: [Auth]
//  *     security:
//  *       - bearerAuth: []
//  *     responses:
//  *       200:
//  *         description: List of users
//  *       401:
//  *         description: Unauthorized
//  *       500:
//  *         description: Server error
//  */
// export const getUser = async (req, res) => {
//   try {
//     const pool = await poolPromise;
//     const result = await pool.request().query("SELECT * FROM Users ORDER BY id DESC");
//     res.json(result.recordset);
//   } catch (err) {
//     console.error("Get Users Error:", err);
//     res.status(500).json({ message: "Server Error" });
//   }
// };

// /**
//  * @swagger
//  * /auth/register:
//  *   post:
//  *     summary: Register a new user
//  *     tags: [Auth]
//  *     security:
//  *       - bearerAuth: []
//  *     requestBody:
//  *       required: true
//  *       content:
//  *         application/json:
//  *           schema:
//  *             type: object
//  *             required: [name, email, password, role]
//  *             properties:
//  *               name:
//  *                 type: string
//  *                 minLength: 2
//  *                 maxLength: 50
//  *               email:
//  *                 type: string
//  *                 format: email
//  *               password:
//  *                 type: string
//  *                 minLength: 6
//  *               role:
//  *                 type: string
//  *     responses:
//  *       200:
//  *         description: User registered successfully
//  *       400:
//  *         description: Validation error
//  *       500:
//  *         description: Server error
//  */
// export const register = async (req, res) => {
//   const { name, email, password, role } = req.body;

//   try {
//     if (!name || !email || !password || !role)
//       return res.status(400).json({ message: "All fields are required." });

//     if (name.length < 2 || name.length > 50)
//       return res.status(400).json({ message: "Name must be 2–50 characters long." });

//     const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
//     if (!emailRegex.test(email))
//       return res.status(400).json({ message: "Invalid email format." });

//     if (password.length < 6)
//       return res.status(400).json({ message: "Password must be at least 6 characters long." });

//     const pool = await poolPromise;
//     const existingUser = await pool
//       .request()
//       .input("email", email)
//       .query("SELECT id FROM Users WHERE email = @email");

//     if (existingUser.recordset.length > 0)
//       return res.status(400).json({ message: "Email already registered." });

//     const hashedPassword = await bcrypt.hash(password, 10);

//     await pool.request()
//       .input("name", name)
//       .input("email", email)
//       .input("password", hashedPassword)
//       .input("role", role)
//       .query("INSERT INTO Users (name, email, password, role) VALUES (@name, @email, @password, @role)");

//     res.json({ message: "User registered successfully!" });
//   } catch (err) {
//     console.error("Register error:", err);
//     res.status(500).json({ message: "Server Error" });
//   }
// };

// /**
//  * @swagger
//  * /auth/login:
//  *   post:
//  *     summary: Login user — returns accessToken + refreshToken
//  *     tags: [Auth]
//  *     requestBody:
//  *       required: true
//  *       content:
//  *         application/json:
//  *           schema:
//  *             type: object
//  *             required: [email, password]
//  *             properties:
//  *               email:
//  *                 type: string
//  *                 format: email
//  *               password:
//  *                 type: string
//  *     responses:
//  *       200:
//  *         description: Login successful
//  *         content:
//  *           application/json:
//  *             schema:
//  *               type: object
//  *               properties:
//  *                 accessToken:
//  *                   type: string
//  *                 refreshToken:
//  *                   type: string
//  *                 user:
//  *                   type: object
//  *       400:
//  *         description: Invalid credentials
//  *       500:
//  *         description: Server error
//  */
// export const login = async (req, res) => {
//   const { email, password } = req.body;
//   try {
//     const pool = await poolPromise;
//     const result = await pool.request()
//       .input("email", email)
//       .query("SELECT * FROM Users WHERE email = @email");

//     const user = result.recordset[0];
//     if (!user) return res.status(400).json({ message: "Invalid credentials" });

//     const isMatch = await bcrypt.compare(password, user.password);
//     if (!isMatch) return res.status(400).json({ message: "Invalid credentials" });

//     const accessToken = generateAccessToken(user);
//     const refreshToken = generateRefreshToken(user);

//     // Persist the refresh token in DB (hashed for security)
//     const hashedRefresh = await bcrypt.hash(refreshToken, 10);
//     await pool.request()
//       .input("refresh_token", hashedRefresh)
//       .input("id", user.id)
//       .query("UPDATE Users SET refresh_token = @refresh_token WHERE id = @id");

//     // Remove sensitive fields before sending user object
//     const { password: _pw, otp: _otp, otp_expiry: _exp, refresh_token: _rt, ...safeUser } = user;

//     res.json({ accessToken, refreshToken, user: safeUser });
//   } catch (err) {
//     console.error("Login error:", err);
//     res.status(500).json({ message: "Server Error" });
//   }
// };

// /**
//  * @swagger
//  * /auth/refresh-token:
//  *   post:
//  *     summary: Issue a new access token using a valid refresh token
//  *     tags: [Auth]
//  *     requestBody:
//  *       required: true
//  *       content:
//  *         application/json:
//  *           schema:
//  *             type: object
//  *             required: [refreshToken]
//  *             properties:
//  *               refreshToken:
//  *                 type: string
//  *     responses:
//  *       200:
//  *         description: New access token issued
//  *         content:
//  *           application/json:
//  *             schema:
//  *               type: object
//  *               properties:
//  *                 accessToken:
//  *                   type: string
//  *       401:
//  *         description: Refresh token missing
//  *       403:
//  *         description: Invalid or expired refresh token
//  *       500:
//  *         description: Server error
//  */
// export const refreshToken = async (req, res) => {
//   const { refreshToken: token } = req.body;

//   if (!token)
//     return res.status(401).json({ message: "Refresh token is required." });

//   try {
//     // Verify the token signature & expiry
//     let decoded;
//     try {
//       decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
//     } catch {
//       return res.status(403).json({ message: "Invalid or expired refresh token." });
//     }

//     // Fetch the stored hashed refresh token from DB
//     const pool = await poolPromise;
//     const result = await pool.request()
//       .input("id", decoded.id)
//       .query("SELECT id, role, refresh_token FROM Users WHERE id = @id");

//     const user = result.recordset[0];
//     if (!user || !user.refresh_token)
//       return res.status(403).json({ message: "Refresh token not found. Please log in again." });

//     // Compare the incoming token with the stored hash
//     const isValid = await bcrypt.compare(token, user.refresh_token);
//     if (!isValid)
//       return res.status(403).json({ message: "Refresh token mismatch. Please log in again." });

//     // Issue a fresh access token
//     const accessToken = generateAccessToken(user);
//     res.json({ accessToken });
//   } catch (err) {
//     console.error("Refresh token error:", err);
//     res.status(500).json({ message: "Server error" });
//   }
// };

// /**
//  * @swagger
//  * /auth/logout:
//  *   post:
//  *     summary: Logout — invalidates the refresh token
//  *     tags: [Auth]
//  *     security:
//  *       - bearerAuth: []
//  *     responses:
//  *       200:
//  *         description: Logged out successfully
//  *       500:
//  *         description: Server error
//  */
// export const logout = async (req, res) => {
//   try {
//     const userId = req.user.id; // populated by your auth middleware

//     const pool = await poolPromise;
//     await pool.request()
//       .input("id", userId)
//       .query("UPDATE Users SET refresh_token = NULL WHERE id = @id");

//     res.json({ message: "Logged out successfully." });
//   } catch (err) {
//     console.error("Logout error:", err);
//     res.status(500).json({ message: "Server error" });
//   }
// };

// // ─── Password Reset ────────────────────────────────────────────────────────────

// const otpExpiryMinutes = 10;

// /**
//  * @swagger
//  * /auth/forget-password:
//  *   post:
//  *     summary: Send OTP for password reset
//  *     tags: [Auth]
//  *     requestBody:
//  *       required: true
//  *       content:
//  *         application/json:
//  *           schema:
//  *             type: object
//  *             required: [email]
//  *             properties:
//  *               email:
//  *                 type: string
//  *                 format: email
//  *     responses:
//  *       200:
//  *         description: OTP sent to email
//  *       400:
//  *         description: Email not registered
//  *       500:
//  *         description: Server error
//  */
// export const forgotPassword = async (req, res) => {
//   const { email } = req.body;

//   if (!email)
//     return res.status(400).json({ message: "Email is required." });

//   try {
//     const pool = await poolPromise;

//     const userResult = await pool.request()
//       .input("email", email)
//       .query("SELECT id FROM Users WHERE email = @email");

//     if (userResult.recordset.length === 0)
//       return res.status(400).json({ message: "Email not registered." });

//     const userId = userResult.recordset[0].id;
//     const otp = Math.floor(100000 + Math.random() * 900000).toString();
//     const otpExpiry = new Date(Date.now() + otpExpiryMinutes * 60000);

//     await pool.request()
//       .input("otp", otp)
//       .input("otp_expiry", otpExpiry)
//       .input("id", userId)
//       .query("UPDATE Users SET otp = @otp, otp_expiry = @otp_expiry WHERE id = @id");

//     const transporter = nodemailer.createTransport({
//       host: "smtp.gmail.com",
//       port: 587,
//       secure: false,
//       auth: {
//         user: process.env.EMAIL_USER,
//         pass: process.env.EMAIL_PASS,
//       },
//     });

//     await transporter.sendMail({
//       from: `"Aaravtech Services" <${process.env.EMAIL_USER}>`,
//       to: email,
//       subject: "Your OTP for Password Reset",
//       text: `Your OTP is ${otp}. It will expire in ${otpExpiryMinutes} minutes.`,
//     });

//     res.json({ message: "OTP sent to your email." });
//   } catch (err) {
//     console.error("Forgot password error:", err);
//     res.status(500).json({ message: "Server error" });
//   }
// };

// export const resetPassword = async (req, res) => {
//   const { email, otp, newPassword } = req.body;

//   if (!email || !otp || !newPassword)
//     return res.status(400).json({ message: "All fields are required." });

//   if (newPassword.length < 6)
//     return res.status(400).json({ message: "Password must be at least 6 characters long." });

//   try {
//     const pool = await poolPromise;

//     const userResult = await pool.request()
//       .input("email", email)
//       .query("SELECT id, otp, otp_expiry FROM Users WHERE email = @email");

//     if (userResult.recordset.length === 0)
//       return res.status(400).json({ message: "Email not registered." });

//     const user = userResult.recordset[0];

//     if (user.otp !== otp)
//       return res.status(400).json({ message: "Invalid OTP." });

//     if (new Date() > new Date(user.otp_expiry))
//       return res.status(400).json({ message: "OTP expired." });

//     const hashedPassword = await bcrypt.hash(newPassword, 10);

//     await pool.request()
//       .input("password", hashedPassword)
//       .input("id", user.id)
//       .query("UPDATE Users SET password = @password, otp = NULL, otp_expiry = NULL WHERE id = @id");

//     res.json({ message: "Password updated successfully!" });
//   } catch (err) {
//     console.error("Reset password error:", err);
//     res.status(500).json({ message: "Server error" });
//   }
// };

// // ─── Profile ──────────────────────────────────────────────────────────────────

// export const getProfile = async (req, res) => {
//   const userId = req.user.id;
//   try {
//     const pool = await poolPromise;
//     const result = await pool.request()
//       .input("id", userId)
//       .query("SELECT id, name, email, role FROM Users WHERE id = @id");

//     const user = result.recordset[0];
//     if (!user) return res.status(404).json({ message: "User not found" });

//     res.json(user);
//   } catch (err) {
//     console.error("Get profile error:", err);
//     res.status(500).json({ message: "Server Error" });
//   }
// };
