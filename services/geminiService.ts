import { GoogleGenAI, Type } from "@google/genai";
import { LevelData, QuestionType, DiagnosticResult, GameMode } from "../types";

// Fallback data
const FALLBACK_LEVEL: LevelData = {
  surahName: "البقرة",
  questions: [
    {
      id: "v1",
      verseNumber: 2,
      type: QuestionType.VERSE_ASSEMBLY,
      prompt: "رتب أجزاء الآية بشكل صحيح",
      arabicText: "ذَلِكَ الْكِتَابُ لاَ رَيْبَ فِيهِ هُدًى لِّلْمُتَّقِينَ",
      hint: "بداية وصف الكتاب.",
      memorizationTip: "الآية تتكون من ثلاث جمل مترابطة.",
      points: 300,
      assemblyData: {
        fragments: [
            { id: "f1", text: "ذَلِكَ الْكِتَابُ", type: 'CORRECT', orderIndex: 0 },
            { id: "f2", text: "لاَ رَيْبَ فِيهِ", type: 'CORRECT', orderIndex: 1 },
            { id: "f3", text: "هُدًى لِّلْمُتَّقِينَ", type: 'CORRECT', orderIndex: 2 },
            { id: "d1", text: "لَا شَكَّ فِيهِ", type: 'DISTRACTOR', orderIndex: -1 }
        ]
      }
    }
  ]
};

// Helper for retry logic
async function retry<T>(fn: () => Promise<T>, retries = 2, delay = 1000): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (retries <= 0) throw error;
    await new Promise(resolve => setTimeout(resolve, delay));
    return retry(fn, retries - 1, delay * 2);
  }
}

export const analyzeRecitation = async (input: { text?: string, audioBase64?: string, targetSurah?: string }): Promise<DiagnosticResult> => {
    if (!process.env.API_KEY) {
        return {
            surahName: "البقرة",
            startVerse: 1,
            endVerse: 5,
            overallScore: 85,
            metrics: { memorization: 90, tajweed: 80, pronunciation: 85 },
            mistakes: [
                { 
                    type: 'PRONUNCIATION', 
                    verse: 1, 
                    text: "الم", 
                    description: "تمديد المد اللازم غير كافٍ",
                    advice: "اجعل المد 6 حركات كاملة (طول النفس العميق)." 
                }
            ],
            diagnosis: "محاكاة: تلاوة جيدة مع بعض الملاحظات في المدود.",
            identifiedText: "الم"
        };
    }
    
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY, apiVersion: 'v1' });

    // Fixed: Using plain object for responseSchema as per guidelines
    const schema = {
        type: Type.OBJECT,
        properties: {
            surahName: { type: Type.STRING },
            startVerse: { type: Type.INTEGER, description: "The verse number where the student should START practicing." },
            endVerse: { type: Type.INTEGER, description: "The verse number where the student should STOP practicing." },
            overallScore: { type: Type.INTEGER, description: "Overall score out of 100." },
            metrics: {
                type: Type.OBJECT,
                properties: {
                    memorization: { type: Type.INTEGER, description: "Accuracy of words and sequence (0-100). Penalize heavily for missing verses." },
                    tajweed: { type: Type.INTEGER, description: "Adherence to Tajweed rules (0-100)." },
                    pronunciation: { type: Type.INTEGER, description: "Clarity and Makharij (0-100)." }
                },
                required: ["memorization", "tajweed", "pronunciation"]
            },
            mistakes: {
                type: Type.ARRAY,
                items: {
                    type: Type.OBJECT,
                    properties: {
                        type: { type: Type.STRING, enum: ["MEMORIZATION", "TAJWEED", "PRONUNCIATION"] },
                        verse: { type: Type.INTEGER },
                        text: { type: Type.STRING, description: "The specific word or phrase involved." },
                        correction: { type: Type.STRING, description: "The correct form (if applicable) or the MISSING text." },
                        description: { type: Type.STRING, description: "Brief explanation of the mistake in Arabic." },
                        advice: { type: Type.STRING, description: "Actionable steps to fix this specific mistake (e.g., tongue position, repetition strategy)." }
                    },
                    required: ["type", "verse", "text", "description", "advice"]
                }
            },
            diagnosis: { type: Type.STRING, description: "Detailed feedback in Arabic. Mention if the user recited the full requested surah or stopped early." },
            identifiedText: { type: Type.STRING, description: "The Arabic text that was recognized." }
        },
        required: ["surahName", "startVerse", "endVerse", "overallScore", "metrics", "mistakes", "diagnosis", "identifiedText"]
    };

    try {
        const parts: any[] = [];
        
        let contextPrompt = "";
        if (input.targetSurah) {
            contextPrompt = `
            TARGET CONTEXT: The user is attempting to recite Surah "${input.targetSurah}".
            
            STRICT HIFZ EXAMINATION RULES:
            1. **CONTINUITY CHECK (IMPORTANT)**: You must detect if the user skips any part of the text.
               - Did they skip a verse in the middle? (e.g., recites Verse 1, then Verse 3).
               - Did they skip a phrase inside a verse?
               - Did they stop early?
            2. **REPORTING GAPS**: If ANY text is missing from the target Surah sequence:
               - Create a 'MEMORIZATION' mistake.
               - In 'description', explicitly state: "Skipped verse X" or "Missed phrase [...]".
               - In 'correction', provide the missing text.
               - Significantly lower the 'memorization' score.
            3. **Transcribe**: First transcribe what was heard, then compare it to the Uthmani text of ${input.targetSurah}.
            `;
        } else {
            contextPrompt = `Identify the Surah and verses recited. Check for standard memorization and tajweed errors.`;
        }

        if (input.audioBase64) {
            parts.push({
                inlineData: { mimeType: "audio/webm", data: input.audioBase64 }
            });
            parts.push({ text: `Analyze this Quran recitation. ${contextPrompt} Provide a detailed breakdown of scores, metrics, and specific mistakes with actionable advice for each.` });
        } else if (input.text) {
            parts.push({ text: `Analyze this written Quranic text: "${input.text}". ${contextPrompt} Provide detailed metrics and check for spelling/memorization errors.` });
        }

        // Fixed: Using gemini-1.5-pro for complex recitation analysis task
        const response = await ai.models.generateContent({
            model: 'gemini-1.5-pro',
            contents: { parts },
            config: {
                responseMimeType: "application/json",
                responseSchema: schema,
                systemInstruction: "You are a strict Quran Hafiz Examiner (Sheikh). Your primary goal is to detect MEMORIZATION GAPS (omissions) and Tajweed errors. If the user skips words or verses, you MUST report them as specific mistakes. Respond in Arabic JSON.",
            }
        });

        const text = response.text;
        if (!text) throw new Error("No response");
        return JSON.parse(text) as DiagnosticResult;

    } catch (error) {
        console.error("Diagnosis failed", error);
        return {
             surahName: input.targetSurah || "البقرة",
             startVerse: 1,
             endVerse: 5,
             overallScore: 0,
             metrics: { memorization: 0, tajweed: 0, pronunciation: 0 },
             mistakes: [],
             diagnosis: "تعذر تحليل الإدخال. يرجى المحاولة مرة أخرى.",
             identifiedText: ""
        };
    }
};

export const checkRecitationGaps = async (audioBase64: string, maskedVerseText: string): Promise<{filledWords: {word: string, isCorrect: boolean}[]}> => {
    if (!process.env.API_KEY) {
        // Mock response for offline testing
        return {
            filledWords: [{ word: "Test", isCorrect: true }]
        };
    }

    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY, apiVersion: 'v1' });
    
    // Fixed: Using plain object for responseSchema as per guidelines
    const schema = {
        type: Type.OBJECT,
        properties: {
            filledWords: {
                type: Type.ARRAY,
                items: {
                    type: Type.OBJECT,
                    properties: {
                        word: { type: Type.STRING, description: "The word spoken by the user for the blank." },
                        isCorrect: { type: Type.BOOLEAN, description: "True ONLY if the spoken word matches the Quranic text for that position." }
                    },
                    required: ["word", "isCorrect"]
                }
            }
        },
        required: ["filledWords"]
    };

    try {
        const parts = [
            { inlineData: { mimeType: "audio/webm", data: audioBase64 } },
            { text: `
                You are a strict Quran Recitation Examiner.
                
                I will provide a verse text where some words are hidden with the placeholder "[MASK]".
                The user has recited the verse.
                
                INPUT TEXT: "${maskedVerseText}"
                
                YOUR TASK:
                1. Listen to the audio corresponding to the "[MASK]" positions.
                2. Transcribe EXACTLY what the user said for each mask.
                3. Compare it to the original Quranic word for that position.
                
                OUTPUT RULES:
                - Return an array of objects, one for each [MASK] in order.
                - If the user said the correct word, return { word: "TheWord", isCorrect: true }.
                - If the user said a WRONG word, return { word: "WhatTheySaid", isCorrect: false }.
                - If the user skipped the word or was silent, return { word: "", isCorrect: false }.
                - DO NOT hallucinate correct words if the user made a mistake. Be strict.
             ` }
        ];

        // Fixed: Using gemini-1.5-flash for complex gap analysis
        const response = await ai.models.generateContent({
            model: 'gemini-1.5-flash',
            contents: { parts },
            config: {
                responseMimeType: "application/json",
                responseSchema: schema
            }
        });

        const text = response.text;
        if (!text) throw new Error("No response");
        return JSON.parse(text);

    } catch (e) {
        console.error("Gap check failed", e);
        return { filledWords: [] };
    }
};

export const generateLevel = async (
    surah: string, 
    startVerse: number = 1, 
    mode: GameMode = 'CLASSIC'
): Promise<LevelData> => {
  if (!process.env.API_KEY) {
    console.warn("No API Key found. Using fallback data.");
    return new Promise(resolve => setTimeout(() => resolve(FALLBACK_LEVEL), 1000));
  }

  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY, apiVersion: 'v1' });
  const batchSize = (mode === 'SURF' || mode === 'STACK' || mode === 'SURVIVOR') ? 8 : (mode === 'LEARN' || mode === 'QUIZ' ? 5 : 3); 

  try {
    const generate = async () => {
        let systemInstruction = "";
        let prompt = "";
        let schema: any;

        if (mode === 'LEARN') {
             systemInstruction = "You are a Quran teacher. Provide the exact Arabic text for the requested verses to help the student memorize.";
             prompt = `Fetch verses ${startVerse} to ${startVerse + batchSize - 1} of Surah "${surah}".
                 OUTPUT LANGUAGE: ARABIC.
                 Game Logic: Provide the full Arabic text for each verse strictly.
                 `;
             
             schema = {
                 type: Type.OBJECT,
                 properties: {
                     surahName: { type: Type.STRING },
                     questions: {
                         type: Type.ARRAY,
                         items: {
                             type: Type.OBJECT,
                             properties: {
                                 id: { type: Type.STRING },
                                 verseNumber: { type: Type.INTEGER },
                                 arabicText: { type: Type.STRING, description: "Full complete arabic text of the verse" },
                                 memorizationTip: { type: Type.STRING, description: "A short tip for memorizing this specific verse" }
                             },
                             required: ["id", "verseNumber", "arabicText", "memorizationTip"]
                         }
                     }
                 },
                 required: ["surahName", "questions"]
             };
        } else if (mode === 'QUIZ') {
            systemInstruction = `
                You are a Senior Islamic Scholar specializing in Quranic Sciences, specifically Tafseer and Vocabulary.
                Your task is to create a high-quality educational quiz based on a specific Surah.
                
                STRICT SOURCE CONSTRAINT:
                - All interpretations (Tafseer) and Vocabulary definitions MUST be derived ONLY from "Tafseer Al-Sa'di" (تفسير السعدي) or "Al-Tafseer Al-Muyassar" (التفسير الميسر).
                - Do NOT invent interpretations. Do NOT use AI hallucinations.
                
                QUESTION DIVERSITY & PLAUSIBILITY:
                - You must generate a mix of question types (Vocabulary, Tafseer, Themes, Precision).
                - DISTRACTORS (Wrong Answers) MUST BE PLAUSIBLE:
                   - Do not use obvious wrong answers.
                   - Use words that share a root, or concepts that are common misconceptions.
                   - Use Mutashabihat (similar sounding words/verses) for precision questions.
            `;
            
            prompt = `Create a 5-question deep learning quiz for Surah "${surah}", verses ${startVerse} to ${startVerse + batchSize}.
                OUTPUT LANGUAGE: ARABIC.

                Generate exactly 5 questions with diverse types:
                1. VOCABULARY: Ask about the meaning of a specific word (Ghareeb al-Quran).
                   - Distractors: Other linguistic meanings or common confusions.
                2. TAFSEER: Ask about the general meaning or implication of a verse.
                   - Distractors: Literal interpretations or meanings of similar verses.
                3. THEME: Ask about the central message or lesson (Hidayat).
                4. PRECISION: Ask to fill in a specific word where synonyms might be confused (Mutashabihat).
                
                Ensure 'explanation' cites the source (e.g., "قال السعدي...").
                `;
            
            schema = {
                type: Type.OBJECT,
                properties: {
                    surahName: { type: Type.STRING },
                    questions: {
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                id: { type: Type.STRING },
                                verseNumber: { type: Type.INTEGER },
                                quizSubType: { type: Type.STRING, enum: ['VOCABULARY', 'TAFSEER', 'THEME', 'PRECISION'], description: "Category of the question" },
                                arabicText: { type: Type.STRING, description: "The Verse Text related to the question" },
                                prompt: { type: Type.STRING, description: "The specific question text" },
                                correctAnswer: { type: Type.STRING, description: "The correct option from Tafseer" },
                                options: { type: Type.ARRAY, items: { type: Type.STRING }, description: "4 options total. Wrong answers must be PLAUSIBLE and tricky." },
                                explanation: { type: Type.STRING, description: "Detailed explanation from Tafseer Al-Sa'di." }
                            },
                            required: ["id", "verseNumber", "quizSubType", "arabicText", "prompt", "correctAnswer", "options", "explanation"]
                        }
                    }
                },
                required: ["surahName", "questions"]
            };

        } else if (mode === 'STACK') {
             systemInstruction = "You are an expert Quran teacher designing a tower building game.";
             prompt = `Create a 'Quran Stack' game level for Surah "${surah}".
                 Target: Verses ${startVerse} to ${startVerse + batchSize - 1} (${batchSize} verses total).
                 OUTPUT LANGUAGE: ARABIC.
                 
                 Game Logic:
                 - Provide the words of these verses in exact sequential order.
                 `;
             
             schema = {
                 type: Type.OBJECT,
                 properties: {
                     surahName: { type: Type.STRING },
                     questions: {
                         type: Type.ARRAY,
                         items: {
                             type: Type.OBJECT,
                             properties: {
                                 id: { type: Type.STRING },
                                 verseNumber: { type: Type.INTEGER },
                                 arabicText: { type: Type.STRING, description: "Full text" },
                                 stackData: {
                                     type: Type.OBJECT,
                                     properties: {
                                         words: { type: Type.ARRAY, items: { type: Type.STRING } }
                                     },
                                     required: ["words"]
                                 }
                             },
                             required: ["id", "verseNumber", "arabicText", "stackData"]
                         }
                     }
                 },
                 required: ["surahName", "questions"]
             };

        } else if (mode === 'SURF' || mode === 'SURVIVOR') {
            systemInstruction = "You are an expert Quran teacher designing a rapid-response game.";
            prompt = `Create a '${mode === 'SURF' ? 'Verse Surfer' : 'Hifz Survivor'}' game level for Surah "${surah}".
                Target: Verses ${startVerse} to ${startVerse + batchSize - 1} (${batchSize} verses total).
                OUTPUT LANGUAGE: ARABIC.
                
                Game Logic:
                - Provide the sequential words for these verses in strict order.
                - Provide a pool of 'distractor' words (Mutashabihat/similar words).
                `;
            
            schema = {
                type: Type.OBJECT,
                properties: {
                    surahName: { type: Type.STRING },
                    questions: {
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                id: { type: Type.STRING },
                                verseNumber: { type: Type.INTEGER },
                                arabicText: { type: Type.STRING, description: "Full text of verses" },
                                surferData: {
                                    type: Type.OBJECT,
                                    properties: {
                                        words: { type: Type.ARRAY, items: { type: Type.STRING } },
                                        distractors: { type: Type.ARRAY, items: { type: Type.STRING } }
                                    },
                                    required: ["words", "distractors"]
                                }
                            },
                            required: ["id", "verseNumber", "arabicText", "surferData"]
                        }
                    }
                },
                required: ["surahName", "questions"]
            };

        } else if (mode === 'ASSEMBLY') {
            systemInstruction = "You are an expert Quran teacher specializing in Mutashabihat (similar verses). You create challenging puzzles.";
            
            prompt = `Create a 'Verse Assembler' game level for Surah "${surah}".
                Generate 3 questions starting from Verse #${startVerse}.
                OUTPUT LANGUAGE: ARABIC.
                
                Game Logic:
                - Analyze the length of verses starting at ${startVerse}.
                - If verses are short (e.g., < 10 words), combine 2 sequential verses into a single puzzle.
                - If verses are long, use a single verse per puzzle.
                - Split the correct text into 4-6 logic fragments (phrases).

                CRITICAL - DISTRACTORS:
                - Generate 3-4 'Distractor' fragments.
                - These MUST be REAL, EXISTING Quranic text from *other* Surahs or verses that are "Mutashabihat" (highly similar and easily confused) with the target verse.
                - Do NOT invent fake Arabic. Use actual similar verses.
                `;
            
            schema = {
                type: Type.OBJECT,
                properties: {
                  surahName: { type: Type.STRING },
                  questions: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        id: { type: Type.STRING },
                        verseNumber: { type: Type.INTEGER, description: "Starting verse number for this block" },
                        arabicText: { type: Type.STRING, description: "Full text of the Verse(s) being assembled." },
                        fragments: {
                           type: Type.ARRAY,
                           items: {
                               type: Type.OBJECT,
                               properties: {
                                   text: { type: Type.STRING },
                                   type: { type: Type.STRING, enum: ['CORRECT', 'DISTRACTOR'] },
                                   orderIndex: { type: Type.INTEGER, description: "Sequential order (0, 1, 2...) for CORRECT items. -1 for DISTRACTOR." }
                               },
                               required: ["text", "type", "orderIndex"]
                           }
                        },
                        hint: { type: Type.STRING },
                        memorizationTip: { type: Type.STRING }
                      },
                      required: ["id", "verseNumber", "arabicText", "fragments", "hint", "memorizationTip"]
                    }
                  }
                },
                required: ["surahName", "questions"]
            };
        } else {
            systemInstruction = "You are an expert Quran teacher. Focus on connecting verses (Robt).";
            prompt = `Create a 'Verse Bridge' game level for Surah "${surah}".
                Generate 3 sequential questions starting from Verse #${startVerse}.
                OUTPUT LANGUAGE: ARABIC.
                
                For each Question:
                1. 'arabicText': The text of Verse N.
                2. 'nextVerseFirstWord': The first word of Verse N+1.
                3. 'options': 3 options for the start of Verse N+1 (1 correct, 2 distractors).
                4. 'wordDistractors': 2 extra distractor words for typing hints.
                `;

            schema = {
                type: Type.OBJECT,
                properties: {
                  surahName: { type: Type.STRING },
                  questions: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        id: { type: Type.STRING },
                        verseNumber: { type: Type.INTEGER },
                        arabicText: { type: Type.STRING, description: "Text of Verse N (The Anchor)." },
                        nextVerseFirstWord: { type: Type.STRING, description: "First word of Verse N+1." },
                        correctAnswer: { type: Type.STRING, description: "The full first phrase of Verse N+1." },
                        options: { type: Type.ARRAY, items: { type: Type.STRING }, description: "3 options for start of Verse N+1." },
                        wordDistractors: { type: Type.ARRAY, items: { type: Type.STRING } },
                        hint: { type: Type.STRING },
                        memorizationTip: { type: Type.STRING }
                      },
                      required: ["id", "verseNumber", "arabicText", "nextVerseFirstWord", "correctAnswer", "options", "hint"]
                    }
                  }
                },
                required: ["surahName", "questions"]
            };
        }

        // Fixed: Using gemini-1.5-pro for complex level generation task
        const response = await ai.models.generateContent({
            model: 'gemini-1.5-pro',
            contents: prompt,
            config: {
              responseMimeType: "application/json",
              responseSchema: schema,
              systemInstruction: systemInstruction,
            }
          });
          return response;
    };

    const response = await retry(generate);
    const text = response.text;
    if (!text) throw new Error("No response text");
    
    const data = JSON.parse(text);

    const processedQuestions = data.questions.map((q: any) => {
      let qType = QuestionType.VERSE_BRIDGE;
      if (mode === 'ASSEMBLY') qType = QuestionType.VERSE_ASSEMBLY;
      if (mode === 'SURF') qType = QuestionType.VERSE_SURFER;
      if (mode === 'STACK') qType = QuestionType.VERSE_STACK;
      if (mode === 'SURVIVOR') qType = QuestionType.VERSE_SURVIVOR;
      if (mode === 'LEARN') qType = QuestionType.VERSE_LEARN;
      if (mode === 'QUIZ') qType = QuestionType.VERSE_QUIZ;

      let processedQ: any = {
          id: q.id || `q-${Math.random()}`,
          prompt: q.prompt || (mode === 'ASSEMBLY' ? `رتب الآيات` : (mode === 'SURF' ? 'التقط الكلمات بالترتيب' : (mode === 'LEARN' ? 'احفظ الآيات' : (mode === 'QUIZ' ? 'اختبار المعاني' : `ما هي بداية الآية التالية؟`)))),
          verseNumber: q.verseNumber || startVerse,
          arabicText: q.arabicText,
          hint: q.hint,
          memorizationTip: q.memorizationTip,
          explanation: q.explanation,
          quizSubType: q.quizSubType, // Pass subType
          points: 300,
          type: qType
      };

      if (mode === 'ASSEMBLY') {
          const fragments = q.fragments.map((f: any, idx: number) => ({
              ...f,
              id: `frag-${q.id}-${idx}-${Math.random().toString(36).substr(2, 9)}`
          }));
          processedQ.assemblyData = { fragments };
      } else if (mode === 'SURF' || mode === 'SURVIVOR') {
          processedQ.surferData = q.surferData;
      } else if (mode === 'STACK') {
          processedQ.stackData = q.stackData;
      } else if (mode === 'LEARN') {
          // No extra data
      } else {
          processedQ.nextVerseFirstWord = q.nextVerseFirstWord;
          processedQ.correctAnswer = q.correctAnswer; 
          processedQ.options = q.options;
          processedQ.wordDistractors = q.wordDistractors;
      }

      return processedQ;
    });

    return {
      surahName: data.surahName || surah,
      questions: processedQuestions
    };

  } catch (error) {
    console.error("Gemini generation failed", error);
    return FALLBACK_LEVEL;
  }
};