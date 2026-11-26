/**
 * Optional chart-image review with Claude, using the user's own Anthropic API key.
 * The key is decrypted here in the main process and never sent to the renderer.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { ChartReviewRequest, ChartReviewResult } from '../shared/api';
import { getApiKey, getSettings } from './store';

const SYSTEM = `You are a technical-analysis tutor inside a personal desktop app.
The user shares a screenshot of a price chart. Write an educational, structured review of what the chart shows.

Use exactly these sections, as Markdown headings:
## Market Condition  (Bullish / Bearish / Neutral / Consolidating, one line of reasoning)
## Confidence  (Low / Medium / High, and what limits it)
## Structure  (trend, swing sequence, breaks of structure, market phase)
## Momentum & Volatility
## Liquidity & Smart-Money Observations  (sweeps, traps, order blocks, imbalances — only if visible)
## Key Levels  (support, resistance, psychological levels; give prices only if they are legible on the chart)
## Risk Environment  (no-trade zones, late-entry or counter-trend cautions)
## Insight Summary  (3-4 sentences)
## Bottom Line

Rules: describe what is visible and say plainly when something cannot be read from the image (symbol, timeframe, exact prices).
Do not invent numbers. Do not give buy/sell instructions, position sizes, or personalised financial advice;
frame conclusions as context and conditions. End with: "Educational review only — not financial advice."`;

export async function reviewChart(req: ChartReviewRequest): Promise<ChartReviewResult> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('Add your Anthropic API key in Settings to use AI chart review.');
  const model = getSettings().aiModel || 'claude-opus-5-5';
  const client = new Anthropic({ apiKey });

  const text = [
    req.prompt?.trim() ? `User note: ${req.prompt.trim()}` : 'Please review this chart.',
    req.context ? `\nThe app's own rule-based analysis of the currently loaded instrument (may or may not match the screenshot):\n${req.context}` : '',
  ].join('\n');

  try {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      system: SYSTEM,
      output_config: { effort: 'high' },
      // Server-side refusal fallback: on a safety decline the API re-runs the request on a fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: req.mediaType, data: req.imageBase64 } },
            { type: 'text', text },
          ],
        },
      ],
    });

    if (response.stop_reason === 'refusal') {
      return { text: 'The model declined to review this image. Try a cleaner chart screenshot.', model: response.model, refused: true };
    }
    const out = response.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    const truncated = response.stop_reason === 'max_tokens' ? '\n\n_(Response was cut off at the output limit.)_' : '';
    return { text: (out || 'No review text was returned.') + truncated, model: response.model, refused: false };
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) throw new Error('The Anthropic API key was rejected. Check it in Settings.');
    if (error instanceof Anthropic.PermissionDeniedError) throw new Error('This API key cannot use the selected model.');
    if (error instanceof Anthropic.RateLimitError) throw new Error('Rate limited by the Anthropic API — try again shortly.');
    if (error instanceof Anthropic.BadRequestError) throw new Error(`Request rejected: ${error.message}`);
    if (error instanceof Anthropic.APIError) throw new Error(`Anthropic API error ${error.status ?? ''}: ${error.message}`);
    if (error instanceof Anthropic.APIConnectionError) throw new Error('Could not reach the Anthropic API. Check your connection.');
    throw error;
  }
}
