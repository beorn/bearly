/**
 * Multi-model consensus logic
 *
 * Queries multiple models in parallel and synthesizes their responses
 */

import { queryModel } from "./research"
import { isProviderAvailable } from "./providers"
import { serializeCost } from "./cost"
import type { Model, ModelResponse, ConsensusResult, ThinkingLevel } from "./types"
import { getModelsForLevel, getModel, MODELS } from "./types"

export interface ConsensusOptions {
  question: string
  level?: ThinkingLevel
  models?: Model[]
  modelIds?: string[]
  synthesize?: boolean
  onModelComplete?: (response: ModelResponse) => void
  /**
   * Abort signal forwarded to every parallel queryModel call. Used by
   * runDebate so Ctrl-C during a $1-3 multi-model run cancels each
   * in-flight request instead of letting them complete and bill.
   */
  abortSignal?: AbortSignal
}

/**
 * Query multiple models and optionally synthesize their responses
 */
export async function consensus(options: ConsensusOptions): Promise<ConsensusResult> {
  const { question, level = "consensus", synthesize = true, onModelComplete, abortSignal } = options
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
      const result = await queryModel({ question, model, abortSignal })
      if (onModelComplete) onModelComplete(result.response)
      return result.response
    }),
  )

  // Build base result
  const result: ConsensusResult = {
    level,
    question,
    responses,
    list_equivalent_basis: [],
    totalDurationMs: Date.now() - startTime,
  }

  // Synthesize if requested and we have multiple responses
  if (synthesize && responses.length > 1) {
    const synthesis = await synthesizeResponses(question, responses, abortSignal)
    result.synthesis = synthesis.synthesis
    result.agreements = synthesis.agreements
    result.disagreements = synthesis.disagreements
    result.confidence = synthesis.confidence
    result.synthesisResponse = synthesis.response
  } else if (responses.length === 1) {
    // Single response - just use it as synthesis
    result.synthesis = responses[0]!.content
    result.confidence = 1
  }

  // Synthesis is a real invoked call even if its answer cannot be parsed.
  const { totalResponseCost } = await import("./format")
  Object.assign(
    result,
    serializeCost(totalResponseCost([...responses, ...(result.synthesisResponse ? [result.synthesisResponse] : [])])),
  )
  result.totalDurationMs = Date.now() - startTime
  return result
}

interface SynthesisResult {
  response?: ModelResponse
  synthesis: string
  agreements: string[]
  disagreements: string[]
  confidence: number
}

/**
 * Synthesize multiple model responses into a unified answer
 */
async function synthesizeResponses(
  question: string,
  responses: ModelResponse[],
  abortSignal?: AbortSignal,
): Promise<SynthesisResult> {
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

  // Use a fast, cheap model for synthesis. claude-3-5-haiku-latest was
  // referenced here historically but isn't in our MODELS registry — the
  // lookup silently falls through to the costTier==="low" fallback, making
  // the explicit preference a no-op. Rewritten to prefer models we actually
  // ship: Claude 4.5 Haiku and GPT-5-nano (both low-cost, fast, reliable).
  const synthesisModel =
    MODELS.find(
      (m) =>
        (m.modelId === "claude-haiku-4-5-20251001" || m.modelId === "gpt-5-nano" || m.modelId === "gpt-4o-mini") &&
        isProviderAvailable(m.provider),
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

  const synthesisStarted = Date.now()
  let response: ModelResponse
  try {
    const result = await queryModel({ question: synthesisPrompt, model: synthesisModel, abortSignal })
    response = result.response
  } catch (error) {
    // Retain an attempted call with unknown accounting instead of making fallback free.
    response = {
      model: synthesisModel,
      content: "",
      durationMs: Date.now() - synthesisStarted,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  try {
    // Parse JSON from response
    const jsonMatch = response.error ? null : response.content.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as {
        synthesis?: string
        agreements?: string[]
        disagreements?: string[]
        confidence?: number
      }
      return {
        response,
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
    response,
    synthesis: responses.map((r) => r.content).join("\n\n---\n\n"),
    agreements: [],
    disagreements: [],
    confidence: 0.5,
  }
}
