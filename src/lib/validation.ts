import { z } from "zod";

export const MAX_MESSAGE_LENGTH = 2000;

export function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, "");
}

const phone = z
  .string()
  .trim()
  .regex(/^\+?[\d\s().-]+$/, "Phone numbers can only contain digits, spaces and + ( ) . -")
  .refine((value) => {
    const count = phoneDigits(value).length;
    return count >= 7 && count <= 15;
  }, "Phone numbers need between 7 and 15 digits");

// Optional, and an empty form field counts as not given.
const email = z
  .union([z.literal(""), z.string().trim().toLowerCase().pipe(z.email("Please check the email address").max(254))])
  .optional()
  .transform((value) => value || undefined);

export const leadSchema = z.strictObject({
  name: z.string().trim().min(1, "Please add a name").max(100),
  phone,
  need: z.string().trim().min(1, "Please say what you need").max(500),
  email,
});
export type LeadInput = Omit<z.infer<typeof leadSchema>, "email"> & { email?: string };

export const handoffSchema = z.strictObject({
  reason: z.string().trim().min(1).max(300),
  summary: z.string().trim().min(1).max(1000),
});

export const chatRequestSchema = z.object({
  conversationId: z.uuid().nullish(),
  message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
});

export const conversationIdSchema = z.uuid();
