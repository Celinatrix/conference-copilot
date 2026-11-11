import { z } from 'zod';
import type { ClientMessage as ClientMessageType } from '@conference-copilot/shared';

// The protocol types live in the shared package so the frontend compiles against the same contract.
export type { RoomStatus, RoomState, SegmentDto, ServerEvent } from '@conference-copilot/shared';
export type ClientMessage = ClientMessageType;

/**
 * Runtime validation of control messages from the browser. The annotation makes the compiler reject this schema
 * if it drifts from the shared ClientMessage type.
 */
export const ClientMessage: z.ZodType<ClientMessageType> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), audioSource: z.string().max(120), consent: z.literal(true) }),
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('resume') }),
  z.object({ type: z.literal('stop') }),
  z.object({ type: z.literal('reclaim') }),
  z.object({ type: z.literal('ping'), t: z.number() }),
]);
