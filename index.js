import express from "express";
import axios from "axios";
import multer from "multer";
import "dotenv/config";
import cors from "cors";
import ResumeParser from "simple-resume-parser";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";

const app = express();
const PORT = process.env.PORT || 3001;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());

const tempDir = path.join(__dirname, "temp");

// Ensure temp directory exists
(async () => {
  await fs.mkdir(tempDir, { recursive: true });
})();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (
      [
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ].includes(file.mimetype)
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF, DOC, DOCX allowed"), false);
    }
  },
});

// Initialize Gemini
const genAi = new GoogleGenAI({
  apiKey: process.env.GOOGLE_AI_STUDIO_KEY,
});

app.post("/api/upload-cv", upload.single("cv"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ msg: "Upload File to continue" });
  }

  const location = req.body.location;
  if (!location) {
    return res.status(400).json({ error: "Location is required" });
  }

  try {
    // Write buffer to temporal file
    const tempFilePath = path.join(
      tempDir,
      `temp-${Date.now()}-${req.file.originalname}`
    );
    await fs.writeFile(tempFilePath, req.file.buffer);

    // Parse the temporal file
    const resume = new ResumeParser(tempFilePath);
    const parsedFile = await resume.parseToJSON();

    // Delete temp file
    await fs.unlink(tempFilePath);

    // Prompting the AI and getting the result
    //const fullText = `${parsedFile.parts.experience || ""} ${
    //parsedFile.parts.skills || ""
    //}`.trim();
    const prompt = `
    You are a professional career-matching AI.
    
    Your task is to analyze a person's CV (in JSON format) and return an array of job titles.
    
    Guidelines:
    - Output must be a **valid JSON array of strings** (e.g. ["Software Engineer", "Hardware Technician", "IT Support Specialist"]).
    - The **first element (index 0)** must be the single, most accurate, and highly specific job title that best represents the candidate’s overall professional identity.
    - Subsequent elements (indexes 1, 2, 3, etc.) should contain other closely related but distinct job titles that reflect additional relevant skills or areas of expertise.
    - If the CV clearly shows only one professional focus (e.g., “Graphic Designer”), return only that one title.
    - Do **not** invent or assume unrelated or weakly connected job titles — the number of items in the array should vary naturally with the person’s real experience (could be 1, 2, 3, or 4 titles).
    
    Rules:
    - Use all context available: experience, certifications, education, and skills.
    - Job titles must be real, standard roles commonly used by employers.
    - Be specific but avoid redundant synonyms (e.g., choose only one of "Software Engineer", "Full-Stack Developer", or "MERN Developer").
    - Do **not** include explanations, notes, or any text outside the JSON array.
    
    Example outputs:
    ["Software Engineer", "Hardware Technician", "IT Support Specialist", "AI Automation Engineer"]
    ["Graphic Designer"]
    ["Civil Engineer", "Construction Supervisor", "Project Estimator"]
    
    CV JSON:
    ${JSON.stringify(parsedFile.parts)}
    `;

    const result = await genAi.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
    });
    const rawKeywordsarr = JSON.parse(result.text.trim());
    const rawKeyword = rawKeywordsarr[0];
    console.log(rawKeyword);

    const keyword = rawKeyword.trim().replace(/\s+/g, "+");
    console.log("Extracted Words:", keyword);

    // Fetch Jobs
    let jobs = [];

    if (keyword) {
      const adzunaResponse = await axios.get(
        "https://api.adzuna.com/v1/api/jobs/us/search/1",
        {
          params: {
            app_id: process.env.ADZUNA_APP_ID,
            app_key: process.env.ADZUNA_APP_KEY,
            what: keyword,
            where: location,
            results_per_page: 10,
            sort_by: "relevance",
          },
        }
      );
      jobs = adzunaResponse.data.results || [];
      console.log(`Found ${jobs.length} jobs for ${location}`);
    }

    console.log("Parsed CV:", parsedFile);
    res.json({
      success: true,
      rawKeyword: rawKeywordsarr,
      location: location,
      // parsed: parsedFile,
      //keywords: keywords,
      jobs: jobs.map((job) => ({
        title: job.title,
        company: job.company.display_name,
        location: job.location.display_name,
        salary: job.salary_text || "Not specified",
        description: job.description.slice(0, 200) + "...",
        url: job.redirect_url,
      })),
    });
  } catch (error) {
    console.error("Error:", error);

    res.status(500).json({
      error: error.message,
    });
  }
});

app.post("/getSpecificJob", async (req, res) => {
  const { index, location, keywords } = req.body;
  try {
    let jobs = [];

    if (index !== undefined && location && keywords) {
      const adzunaResponse = await axios.get(
        "https://api.adzuna.com/v1/api/jobs/us/search/1",
        {
          params: {
            app_id: process.env.ADZUNA_APP_ID,
            app_key: process.env.ADZUNA_APP_KEY,
            what: keywords[index],
            where: location,
            results_per_page: 10,
            sort_by: "relevance",
          },
        }
      );

      jobs = adzunaResponse.data.results || [];
      console.log(`Found ${jobs.length} jobs for ${location}`);
    } else {
      return res.status(400).json({ error: "Index is required" });
    }

    res.status(200).json({ jobs });
  } catch (error) {
    console.error("Error fetching specific jobs:", error.message);
    res.status(500).json({ error: "Failed to fetch jobs" });
  }
});

app.listen(PORT, () => {
  console.log(`Listening On Port ${PORT}`);
});
