import { and, desc, eq, lt, or } from 'drizzle-orm';
import {
  makeId,
  type Character,
  type CreateCharacterRequest,
  type UpdateCharacterRequest,
  type Paginated,
} from '@sudobility/characterbuilder_types';
import { getDb, characters } from '../db';
import { HttpError } from '../lib/errors';

type Row = typeof characters.$inferSelect;

function toCharacter(r: Row): Character {
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    notes: r.notes,
    spec: r.spec,
    previewImageId: r.previewImageId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Cursor = base64url("<updatedAtMs>:<id>"), keyset over (updatedAt desc, id desc). */
function encodeCursor(r: Row): string {
  return Buffer.from(`${r.updatedAt.getTime()}:${r.id}`).toString('base64url');
}
function decodeCursor(cursor: string): { ms: number; id: string } | null {
  try {
    const [ms, id] = Buffer.from(cursor, 'base64url').toString('utf8').split(':');
    if (!ms || !id) return null;
    return { ms: Number(ms), id };
  } catch {
    return null;
  }
}

export async function listCharacters(
  userId: string,
  limit: number,
  cursor?: string
): Promise<Paginated<Character>> {
  const db = getDb();
  const after = cursor ? decodeCursor(cursor) : null;
  const where = after
    ? and(
        eq(characters.userId, userId),
        or(
          lt(characters.updatedAt, new Date(after.ms)),
          and(
            eq(characters.updatedAt, new Date(after.ms)),
            lt(characters.id, after.id)
          )
        )
      )
    : eq(characters.userId, userId);
  const rows = await db
    .select()
    .from(characters)
    .where(where)
    .orderBy(desc(characters.updatedAt), desc(characters.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1]!) : null;
  return { items: page.map(toCharacter), nextCursor };
}

export async function getCharacter(
  userId: string,
  id: string
): Promise<Character> {
  const [row] = await getDb()
    .select()
    .from(characters)
    .where(and(eq(characters.id, id), eq(characters.userId, userId)));
  if (!row) throw new HttpError('CHARACTER_NOT_FOUND', 'Character not found');
  return toCharacter(row);
}

export async function createCharacter(
  userId: string,
  req: CreateCharacterRequest
): Promise<Character> {
  const id = makeId('character', crypto.randomUUID().replace(/-/g, ''));
  const [row] = await getDb()
    .insert(characters)
    .values({
      id,
      userId,
      name: req.name,
      role: req.role ?? null,
      notes: req.notes ?? null,
      spec: req.spec ?? {},
    })
    .returning();
  return toCharacter(row!);
}

export async function updateCharacter(
  userId: string,
  id: string,
  req: UpdateCharacterRequest
): Promise<Character> {
  await getCharacter(userId, id); // 404 if not owned
  const patch: Partial<Row> = { updatedAt: new Date() };
  if (req.name !== undefined) patch.name = req.name;
  if (req.role !== undefined) patch.role = req.role;
  if (req.notes !== undefined) patch.notes = req.notes;
  if (req.spec !== undefined) patch.spec = req.spec;
  if (req.previewImageId !== undefined) patch.previewImageId = req.previewImageId;
  const [row] = await getDb()
    .update(characters)
    .set(patch)
    .where(and(eq(characters.id, id), eq(characters.userId, userId)))
    .returning();
  return toCharacter(row!);
}

export async function deleteCharacter(userId: string, id: string): Promise<void> {
  const result = await getDb()
    .delete(characters)
    .where(and(eq(characters.id, id), eq(characters.userId, userId)))
    .returning({ id: characters.id });
  if (result.length === 0)
    throw new HttpError('CHARACTER_NOT_FOUND', 'Character not found');
}
