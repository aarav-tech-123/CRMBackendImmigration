import express from 'express';
import jwt from "jsonwebtoken";
const router = express.Router();
import dotenv from "dotenv";
dotenv.config();

export const verifyToken = (req, res, next) => {
  try {
    // Extract token from Authorization header
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1]; // Bearer <token>
    if (!token) {
      return res.status(403).json({ message: "Access Denied. No token provided." });
    }

    // Verify the token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Attach user data to the request
    req.user = decoded;

    next(); // move on to next middleware (authorize)
  } catch (err) {
    console.error("JWT verification error:", err.message);
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};


export const authorize = (roles = []) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: 'Not authenticated' });
  if (roles.length && !roles.includes(req.user.role)) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  next();
};

// Roles can be passed as an array of strings, e.g., ['Agent', 'Admin', 'SuperAdmin']
