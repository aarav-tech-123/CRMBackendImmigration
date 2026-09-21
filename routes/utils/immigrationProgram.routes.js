import express from "express"
import { verifyToken, authorize } from "../../middleware/auth.middleware.js"
import { getAllPrograms } from "../../controllers/utils/immigrationProgram.controller.js"


const router = express.Router()


router.get("/", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getAllPrograms)



export default router;