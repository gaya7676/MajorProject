
require("dotenv").config({ path: "backend/.env" });

const { GoogleGenAI } = require("@google/genai");

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error("Gemini API key is missing!");
    process.exitCode = 1;
    return;
  }

  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
  });

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: "Reply with: Credixa Gemini test successful",
    });

    console.log("Gemini test successful!");
    console.log(response.text);
  } catch (error) {
    console.error("Gemini test failed.");
    console.error("Status:", error.status);
    console.error("Message:", error.message);
    process.exitCode = 1;
  }
}

main();
