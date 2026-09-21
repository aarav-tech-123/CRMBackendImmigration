import express from "express"
import { verifyToken, authorize } from "../../middleware/auth.middleware.js"
import {
  getAllDocumentTypes,
  createDocumentType,
  updateDocumentType,
  deleteDocumentType,
} from "../../controllers/utils/documentType.controller.js"


const router = express.Router()


router.get("/", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getAllDocumentTypes)
router.get("/:documentTypeId", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getAllDocumentTypes)
router.post("/", verifyToken, authorize(["Manager", "SuperAdmin"]), createDocumentType)
router.patch("/:documentTypeId", verifyToken, authorize(["Manager", "SuperAdmin"]), updateDocumentType)
router.delete("/:documentTypeId", verifyToken, authorize(["Manager", "SuperAdmin"]), deleteDocumentType)



export default router;
