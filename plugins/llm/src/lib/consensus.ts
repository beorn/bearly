/**
 * Multi-model consensus logic
 *
 * Queries multiple models in parallel and synthesizes their responses
 */

import { queryModel } from "./research"
import { getLanguageModel, isProviderAvailable } from "./providers"
import { generateText } from "ai"
import type { Model, ModelResponse, ConsensusResult, ThinkingLevel } from "./types"
import { getModelsForLevel, getModel, MODELS } from "./types"

export interface ConsensusOptions {
  question: string
  level?: ThinkingLevel
  models?: Model[]
  modelIds?: string[]
  synthesize?: boolean
  onModelComplete?: (response: ModelResponse) => void
}

/**
 * Query multiple models and optionally synthesize their responses
 */
export async function consensus(options: ConsensusOptions): Promise<ConsensusResult> {
  const { question, level = "consensus", synthesize = true, onModelComplete } = options
  const startTime = Date.now()

  // Determine which models to use
  let models: Model[]
  if (options.models) {
    models = options.models
  } else if (options.modelIds) {
    models = options.modelIds.map((id) => {
      const model = getModel(id)
      if (!model) throw new Error(`Unknown model: ${id}`)
      return model
    })
  } else {
    models = getModelsForLevel(level)
  }

  // Filter to available models only
  const availableModels = models.filter((m) => isProviderAvailable(m.provider))
  if (availableModels.length === 0) {
    throw new Error("No models available for consensus (check API keys)")
  }

  // Query all models in parallel
  const responses = await Promise.all(
    availableModels.map(async (model) => {
      const result = await queryModel({ question, model })
      if (onModelComplete) onModelComplete(result.response)
      return result.response
    }),
  )

  // Calculate total cost
  const totalCost = responses.reduce((sum, r) => sum + (r.usage?.estimatedCost || 0), 0)

  // Build base result
  const result: ConsensusResult = {
    level,
    question,
    responses,
    totalCost,
    totalDurationMs: Date.now() - startTime,
  }

  // Synthesize if requested and we have multiple responses
  if (synthesize && responses.length > 1) {
    const synthesis = await synthesizeResponses(question, responses)
    result.synthesis = synthesis.synthesis
    result.agreements = synthesis.agreements
    result.disagreements = synthesis.disagreements
    result.confidence = synthesis.confidence
  } else if (responses.length === 1) {
    // Single response - just use it as synthesis
    result.synthesis = responses[0]!.content
    result.confidence = 1
  }

  return result
}

interface SynthesisResult {
  synthesis: string
  agreements: string[]
  disagreements: string[]
  confidence: number
}

/**
 * Synthesize multiple model responses into a unified answer
 */
async function synthesizeResponses(question: string, responses: ModelResponse[]): Promise<SynthesisResult> {
  // Format responses for the synthesis prompt
  const formattedResponses = responses
    .filter((r) => !r.error && r.content)
    .map((r, i) => `### Model ${i + 1}: ${r.model.displayName}\n${r.content}`)
    .join("\n\n")

  const synthesisPrompt = `You are synthesizing responses from multiple AI models to the following question:

**Question:** ${question}

**Model Responses:**
${formattedResponses}

Please provide:
1. **SYNTHESIS**: A unified answer that incorporates the best insights from all models
2. **AGREEMENTS**: Key points where models agree (bullet list)
3. **DISAGREEMENTS**: Points where models disagree or provide different information (bullet list)
4. **CONFIDENCE**: A confidence score from 0-100 based on model agreement and quality of responses

Format your response as JSON:
{
  "synthesis": "...",
  "agreements": ["...", "..."],
  "disagreements": ["...", "..."],
  "confidence": 85
}`

  // Use a fast, cheap model for synthesis (prefer Claude or GPT-4o-mini)
  const synthesisModel =
    MODELS.find(
      (m) =>
        (m.modelId === "claude-3-5-haiku-latest" || m.modelId === "gpt-4o-mini") && isProviderAvailable(m.provider),
    ) || MODELS.find((m) => m.costTier === "low" && isProviderAvailable(m.provider))

  if (!synthesisModel) {
    // Fallback: just concatenate responses
    return {
      synthesis: responses.map((r) => r.content).join("\n\n---\n\n"),
      agreements: [],
      disagreements: [],
      confidence: 0.5,
    }
  }

  try {
    const result = await generateText({
      model: getLanguageModel(synthesisModel),
      messages: [{ role: "user", content: synthesisPrompt }],
    })

    // Parse JSON from response
    const jsonMatch = result.text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as {
        synthesis?: string
        agreements?: string[]
        disagreements?: string[]
        confidence?: number
      }
      return {
        synthesis: parsed.synthesis || "",
        agreements: parsed.agreements || [],
        disagreements: parsed.disagreements || [],
        confidence: (parsed.confidence || 50) / 100,
      }
    }
  } catch {
    // Parsing failed, fall back to simple concatenation
  }

  return {
    synthesis: responses.map((r) => r.content).join("\n\n---\n\n"),
    agreements: [],
    disagreements: [],
    confidence: 0.5,
  }
}

/**
 * Deep consensus: use all deep research models
 */
export async function deepConsensus(
  question: string,
  options: { onModelComplete?: (response: ModelResponse) => void } = {},
): Promise<ConsensusResult> {
  const deepModels = MODELS.filter((m) => m.isDeepResearch && isProviderAvailable(m.provider))

  if (deepModels.length === 0) {
    throw new Error("No deep research models available")
  }

  // Enhanced research prompt for deep consensus
  const researchPrompt = `Conduct thorough research on the following question. Provide comprehensive analysis with sources where possible.

${question}

Please include:
- Detailed analysis
- Multiple perspectives
- Recent developments
- Cited sources (if available)
- Confidence in your findings`

  return consensus({
    question: researchPrompt,
    level: "deep",
    models: deepModels,
    synthesize: true,
    ...options,
  })
}
