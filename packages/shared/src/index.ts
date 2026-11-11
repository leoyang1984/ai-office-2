import { z } from 'zod';

export const uuid = z.uuid();
export const username = z.string().min(3).max(32).regex(/^[a-z][a-z0-9_-]+$/);
export const displayName = z.string().trim().min(1).max(80);
export const password = z.string().min(12).max(128);
export const managedDirectory = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const role = z.enum(['ADMIN', 'USER']);
export const accountStatus = z.enum(['active', 'disabled']);
export const account = z.object({
  id: uuid, username, displayName, role, status: accountStatus, mustChangePassword: z.boolean(),
});
export const login = z.object({ username, password: z.string().min(1).max(128) }).strict();
export const changePassword = z.object({ currentPassword: z.string().min(1).max(128), newPassword: password }).strict();
export const createUser = z.object({
  username, displayName, password, knowledgeIds: z.array(uuid).max(32).default([]),
}).strict();
export const updateUser = z.object({
  status: accountStatus.optional(), password: password.optional(),
}).strict().refine(value => value.status !== undefined || value.password !== undefined);
export const registerKnowledge = z.object({ name: displayName, directory: managedDirectory }).strict();
export const knowledge = z.object({ id: uuid, name: displayName });
export const grant = z.object({ id: uuid, name: displayName, permission: z.literal('READ_ONLY') });
export const conversation = z.object({ id: uuid, title: displayName, updatedAt: z.number() });
export const createConversation = z.object({ title: displayName }).strict();
export const sendMessage = z.object({ text: z.string().trim().min(1).max(8_000), requestId: uuid, attachmentId: uuid.optional() }).strict();
export const message = z.object({ id: uuid, role: z.enum(['user', 'assistant']), text: z.string() });
export const conversationDetail = conversation.extend({ messages: z.array(message) });
export const file = z.object({
  id: uuid, name: z.string(), mime: z.string(), size: z.number(), source: z.enum(['upload', 'output']),
});
export const maxAttachedImage = 2 * 1024 * 1024;
export const imageMime = z.enum(['image/png', 'image/jpeg', 'image/webp']);
export const conversationEvent = z.object({
  seq: z.number(), turnId: uuid, type: z.enum(['queued', 'started', 'tool', 'delta', 'completed', 'failed']),
  text: z.string().nullable(), createdAt: z.number(),
});
export const auditEvent = z.object({
  id: z.number(), at: z.number(), actorId: uuid.nullable(), action: z.string(), targetId: uuid.nullable(),
  success: z.boolean(), ip: z.string(), requestId: z.string(),
});
export const page = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
}).strict();
export const ok = z.object({ ok: z.literal(true) });
export const nativeStatus = z.object({ enabled: z.boolean(), skills: z.boolean().optional() });
export const readiness = ok.extend({ agent: z.enum(['mock', 'dsh']) });
export const errorBody = z.object({ error: z.object({ code: z.string(), message: z.string(), requestId: z.string() }) });
export type Account = z.infer<typeof account>;
export type Conversation = z.infer<typeof conversation>;
export type ConversationDetail = z.infer<typeof conversationDetail>;
export type OfficeFile = z.infer<typeof file>;
export type Grant = z.infer<typeof grant>;
export type Knowledge = z.infer<typeof knowledge>;

export const skillName = z.string().max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
export const skillVersion = z.string().max(24).regex(/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/);
const skillDescription = z.string().trim().min(1).max(240).regex(/^[^\x00-\x1f\x7f]+$/);
export const skillResourceName = z.string().max(64).regex(/^[a-z0-9][a-z0-9_-]*\.(?:md|txt|json|csv)$/);
export const skillInput = z.object({
  name: skillName,
  version: skillVersion,
  description: skillDescription,
  instructions: z.string().trim().min(1).max(32_768),
  resources: z.array(z.object({
    name: skillResourceName, text: z.string().max(16_384),
  }).strict()).max(8).default([]),
}).strict();
export const skillInfo = z.object({
  id: uuid, name: skillName, version: skillVersion, description: skillDescription,
});
export const skillLibrary = z.object({ public: skillInfo.array(), personal: skillInfo.array() });
export type SkillInput = z.infer<typeof skillInput>;
export type SkillInfo = z.infer<typeof skillInfo>;
