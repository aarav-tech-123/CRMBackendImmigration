import express from "express";
import { register, login, getUser, forgotPassword, resetPassword, updateProfile } from "../controllers/auth.controller.js";
import { verifyToken, authorize } from "../middleware/auth.middleware.js";

const router = express.Router();

router.post("/register", verifyToken, register);
router.post("/login", login);
router.post("/forget-password", forgotPassword);
router.post("/reset-password", resetPassword);
router.get("/users", verifyToken, authorize(["Manager", "SuperAdmin", "Agent"]), getUser);
router.put("/:id", verifyToken, authorize(["SuperAdmin"]), updateProfile);





export default router;
