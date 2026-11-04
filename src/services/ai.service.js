import { AppError } from '../utils/errors.js';

const REQUEST_TIMEOUT = 60_000;
const MAX_MESSAGE_LENGTH = 10_000;

const getAIConfig = () => {
  const {
    AI_API_KEY,
    AI_BASE_URL,
    AI_MODEL
  } = process.env;

  if (!AI_API_KEY || !AI_BASE_URL || !AI_MODEL) {
    throw new AppError(
      'AI provider is not configured.',
      503,
      'AI_NOT_CONFIGURED'
    );
  }

  let baseUrl;

  try {
    baseUrl = new URL(AI_BASE_URL);
  } catch {
    throw new AppError(
      'AI provider URL is invalid.',
      500,
      'AI_CONFIGURATION_ERROR'
    );
  }

  if (
    baseUrl.protocol !== 'https:' &&
    baseUrl.hostname !== 'localhost' &&
    baseUrl.hostname !== '127.0.0.1'
  ) {
    throw new AppError(
      'AI provider must use HTTPS.',
      500,
      'AI_CONFIGURATION_ERROR'
    );
  }

  return {
    apiKey: AI_API_KEY,
    baseUrl: AI_BASE_URL.replace(/\/+$/, ''),
    model: AI_MODEL
  };
};

export const sendAIMessage = async ({
  message,
  conversation = []
}) => {
  if (
    typeof message !== 'string' ||
    !message.trim() ||
    message.length > MAX_MESSAGE_LENGTH
  ) {
    throw new AppError(
      'Invalid AI message.',
      400,
      'INVALID_AI_MESSAGE'
    );
  }

  if (!Array.isArray(conversation)) {
    throw new AppError(
      'Conversation must be an array.',
      400,
      'INVALID_CONVERSATION'
    );
  }

  if (conversation.length > 50) {
    throw new AppError(
      'Conversation history is too large.',
      400,
      'CONVERSATION_LIMIT_EXCEEDED'
    );
  }

  const messages = conversation.map((item) => {
    if (
      !item ||
      !['user', 'assistant'].includes(item.role) ||
      typeof item.content !== 'string' ||
      item.content.length > MAX_MESSAGE_LENGTH
    ) {
      throw new AppError(
        'Invalid conversation history.',
        400,
        'INVALID_CONVERSATION'
      );
    }

    return {
      role: item.role,
      content: item.content
    };
  });

  messages.push({
    role: 'user',
    content: message.trim()
  });

  const config = getAIConfig();

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT
  );

  try {
    const response = await fetch(
      `${config.baseUrl}/chat/completions`,
      {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`
        },

        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: 0.7
        }),

        signal: controller.signal
      }
    );

    if (!response.ok) {
      console.error('[NOXRIDGE AI ERROR]', {
        status: response.status
      });

      throw new AppError(
        'AI provider request failed.',
        502,
        'AI_PROVIDER_ERROR'
      );
    }

    const data = await response.json();

    const answer = data?.choices?.[0]?.message?.content;

    if (typeof answer !== 'string' || !answer.trim()) {
      throw new AppError(
        'AI provider returned an invalid response.',
        502,
        'AI_INVALID_RESPONSE'
      );
    }

    return {
      success: true,
      model: config.model,
      answer: answer.trim()
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new AppError(
        'AI provider request timed out.',
        504,
        'AI_TIMEOUT'
      );
    }

    if (error instanceof AppError) {
      throw error;
    }

    console.error('[NOXRIDGE AI CONNECTION ERROR]', {
      name: error.name
    });

    throw new AppError(
      'Unable to connect to AI provider.',
      502,
      'AI_CONNECTION_FAILED'
    );
  } finally {
    clearTimeout(timeout);
  }
};
