import {
  addDoc,
  Timestamp,
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch
} from "firebase/firestore";

export const DEFAULT_COLUMNS = [
  { id: "todo", name: "A fazer", order: 0 },
  { id: "progress", name: "Em andamento", order: 1 },
  { id: "review", name: "Em revisão", order: 2 },
  { id: "done", name: "Concluído", order: 3 }
];

const INITIAL_BOARD_NAME = "Meu quadro";
const MIGRATION_ID = "initial-board-v1";
const MIGRATION_LEASE_MS = 60_000;
const MIGRATION_WAIT_MS = 5 * 60_000;
const MIGRATION_BATCH_SIZE = 400;

export function getInitialBoardId(userId) {
  return `initial-${userId}`;
}

function getMigrationReference(db, userId) {
  return doc(db, "users", userId, "migrations", MIGRATION_ID);
}

function toMillis(value) {
  return value && typeof value.toMillis === "function" ? value.toMillis() : 0;
}

export function sortBoards(boards) {
  return [...boards].sort((left, right) => {
    const creationOrder = toMillis(left.createdAt) - toMillis(right.createdAt);
    return creationOrder || left.id.localeCompare(right.id);
  });
}

export async function loadOwnedBoards(db, userId) {
  const boardsQuery = query(
    collection(db, "boards"),
    where("ownerUid", "==", userId)
  );
  const snapshot = await getDocs(boardsQuery);
  return sortBoards(snapshot.docs.map((boardDocument) => ({
    ...boardDocument.data(),
    id: boardDocument.id
  })));
}

export async function loadAccessibleBoards(db, userId) {
  const [ownedBoards, memberships] = await Promise.all([
    loadOwnedBoards(db, userId),
    getDocs(query(
      collectionGroup(db, "members"),
      where("uid", "==", userId)
    ))
  ]);
  const accessibleBoards = new Map(ownedBoards.map((board) => [
    board.id,
    { ...board, role: "owner" }
  ]));
  const memberBoards = new Map();

  memberships.docs.forEach((membershipDocument) => {
    const membership = membershipDocument.data();
    const boardReference = membershipDocument.ref.parent.parent;
    if (!boardReference || membership.uid !== userId ||
        !["editor", "reader"].includes(membership.role)) {
      throw new Error("O Firestore contém um registro de membro inválido.");
    }

    if (!accessibleBoards.has(boardReference.id)) {
      memberBoards.set(boardReference.id, membership.role);
    }
  });

  const boardSnapshots = await Promise.all(
    [...memberBoards.keys()].map((boardId) => getDoc(doc(db, "boards", boardId)))
  );
  boardSnapshots.forEach((boardSnapshot) => {
    if (!boardSnapshot.exists()) {
      console.warn(`O registro de membro aponta para o quadro inexistente "${boardSnapshot.id}".`);
      return;
    }

    const board = {
      ...boardSnapshot.data(),
      id: boardSnapshot.id,
      role: boardSnapshot.data().ownerUid === userId
        ? "owner"
        : memberBoards.get(boardSnapshot.id)
    };
    accessibleBoards.set(board.id, board);
  });

  return sortBoards([...accessibleBoards.values()]);
}

export async function loadBoardMembers(db, boardId, ownerUid) {
  const snapshot = await getDocs(collection(db, "boards", boardId, "members"));
  const members = snapshot.docs.map((memberDocument) => {
    const member = memberDocument.data();
    if (member.uid !== memberDocument.id ||
        member.uid === ownerUid ||
        !["editor", "reader"].includes(member.role)) {
      throw new Error("O Firestore contém um registro de membro inválido.");
    }

    return {
      uid: member.uid,
      name: typeof member.name === "string" ? member.name.trim() : "",
      role: member.role,
      addedAt: member.addedAt,
      isOwner: false
    };
  });

  members.sort((left, right) => left.uid.localeCompare(right.uid));
  return [
    { uid: ownerUid, role: "owner", isOwner: true },
    ...members
  ];
}

export async function updateBoardMemberRole(db, boardId, ownerUid, memberUid, role) {
  if (memberUid === ownerUid) {
    throw new Error("O proprietário não pode ter o próprio papel alterado.");
  }
  if (!["editor", "reader"].includes(role)) {
    throw new Error("O papel do membro não é válido.");
  }

  await updateDoc(doc(db, "boards", boardId, "members", memberUid), { role });
}

export async function removeBoardMember(db, boardId, ownerUid, memberUid) {
  if (memberUid === ownerUid) {
    throw new Error("O proprietário não pode remover o próprio acesso.");
  }

  await deleteDoc(doc(db, "boards", boardId, "members", memberUid));
}

function normalizeInvitationEmail(email) {
  if (typeof email !== "string") {
    throw new Error("Informe um e-mail válido para o convite.");
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (normalizedEmail.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new Error("Informe um e-mail válido para o convite.");
  }
  return normalizedEmail;
}

function mapInvitation(invitationDocument) {
  const invitation = invitationDocument.data();
  const boardReference = invitationDocument.ref.parent.parent;
  if (!boardReference ||
      boardReference.parent.id !== "boards" ||
      typeof invitation.email !== "string" ||
      invitation.email !== normalizeInvitationEmail(invitation.email) ||
      typeof invitation.ownerUid !== "string" ||
      typeof invitation.boardName !== "string" ||
      !["editor", "reader"].includes(invitation.role) ||
      !["pending", "accepted", "declined", "cancelled"].includes(invitation.status)) {
    throw new Error("O Firestore contém um convite em formato inválido.");
  }

  return {
    ...invitation,
    ownerName: typeof invitation.ownerName === "string" ? invitation.ownerName.trim() : "",
    id: invitationDocument.id,
    boardId: boardReference.id
  };
}

export async function createBoardInvitation(db, board, ownerUid, email, role, ownerName) {
  if (!board || board.ownerUid !== ownerUid) {
    throw new Error("Somente o proprietário pode convidar pessoas para este quadro.");
  }
  if (!["editor", "reader"].includes(role)) {
    throw new Error("Selecione um papel válido para o convite.");
  }

  const normalizedEmail = normalizeInvitationEmail(email);
  const existingInvitations = await loadBoardInvitations(db, board.id, ownerUid);
  if (existingInvitations.some((invitation) => invitation.email === normalizedEmail)) {
    throw new Error("Já existe um convite pendente para esse e-mail.");
  }

  const invitationReference = await addDoc(
    collection(db, "boards", board.id, "invitations"),
    {
      email: normalizedEmail,
      ownerUid,
      ownerName: typeof ownerName === "string" ? ownerName.trim() : "",
      boardName: board.name,
      role,
      status: "pending",
      createdAt: serverTimestamp()
    }
  );
  return invitationReference.id;
}

export async function loadBoardInvitations(db, boardId, ownerUid) {
  const snapshot = await getDocs(collection(db, "boards", boardId, "invitations"));
  return snapshot.docs
    .map(mapInvitation)
    .filter((invitation) => {
      if (invitation.ownerUid !== ownerUid) {
        throw new Error("O Firestore contém um convite associado a outro proprietário.");
      }
      return invitation.status === "pending";
    })
    .sort((left, right) => toMillis(right.createdAt) - toMillis(left.createdAt));
}

export async function loadReceivedInvitations(db, email) {
  const normalizedEmail = normalizeInvitationEmail(email);
  const snapshot = await getDocs(query(
    collectionGroup(db, "invitations"),
    where("email", "==", normalizedEmail)
  ));

  return snapshot.docs
    .map(mapInvitation)
    .filter((invitation) => invitation.status === "pending")
    .sort((left, right) => toMillis(right.createdAt) - toMillis(left.createdAt));
}

export async function cancelBoardInvitation(db, boardId, invitationId, ownerUid) {
  if (!boardId || !invitationId || !ownerUid) {
    throw new Error("Não foi possível identificar o convite a cancelar.");
  }
  await updateDoc(
    doc(db, "boards", boardId, "invitations", invitationId),
    { status: "cancelled" }
  );
}

export async function respondToBoardInvitation(db, user, invitation, response) {
  if (!user || !user.uid || !user.email) {
    throw new Error("Entre em uma conta autenticada que possua um endereço de e-mail para responder ao convite.");
  }
  if (!["accepted", "declined"].includes(response)) {
    throw new Error("A resposta ao convite não é válida.");
  }

  const normalizedEmail = normalizeInvitationEmail(user.email);
  const invitationReference = doc(
    db,
    "boards",
    invitation.boardId,
    "invitations",
    invitation.id
  );
  const memberReference = doc(
    db,
    "boards",
    invitation.boardId,
    "members",
    user.uid
  );

  await runTransaction(db, async (transaction) => {
    const invitationSnapshot = await transaction.get(invitationReference);
    if (!invitationSnapshot.exists()) {
      throw new Error("Este convite não existe mais.");
    }

    const currentInvitation = invitationSnapshot.data();
    if (currentInvitation.status !== "pending") {
      throw new Error("Este convite já foi respondido ou cancelado.");
    }
    if (normalizeInvitationEmail(currentInvitation.email) !== normalizedEmail ||
        !["editor", "reader"].includes(currentInvitation.role)) {
      throw new Error("Este convite não pertence à conta autenticada ou está inválido.");
    }

    if (response === "accepted") {
      const memberSnapshot = await transaction.get(memberReference);
      if (memberSnapshot.exists()) {
        throw new Error("Você já possui acesso a este quadro.");
      }

      transaction.set(memberReference, {
        uid: user.uid,
        name: typeof user.displayName === "string" ? user.displayName.trim() : "",
        role: currentInvitation.role,
        addedAt: serverTimestamp(),
        invitationId: invitation.id
      });
    }

    transaction.update(invitationReference, { status: response });
  });
}

export async function loadBoardColumns(db, boardId) {
  const snapshot = await getDocs(collection(db, "boards", boardId, "columns"));
  return snapshot.docs
    .map((columnDocument) => ({
      ...columnDocument.data(),
      id: columnDocument.id
    }))
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

export async function createBoard(db, userId, name, boardId = doc(collection(db, "boards")).id) {
  const boardReference = doc(db, "boards", boardId);
  const batch = writeBatch(db);
  const timestamp = serverTimestamp();

  batch.set(boardReference, {
    name,
    ownerUid: userId,
    createdAt: timestamp,
    updatedAt: timestamp
  });

  DEFAULT_COLUMNS.forEach((column) => {
    batch.set(doc(boardReference, "columns", column.id), {
      name: column.name,
      order: column.order,
      createdAt: timestamp
    });
  });

  await batch.commit();
  return {
    id: boardReference.id,
    name,
    ownerUid: userId
  };
}

export async function deleteOwnedBoard(db, boardId, ownerUid) {
  if (!boardId || !ownerUid) {
    throw new Error("Não foi possível identificar o quadro a excluir.");
  }

  const boardReference = doc(db, "boards", boardId);
  const boardSnapshot = await getDoc(boardReference);
  if (!boardSnapshot.exists() || boardSnapshot.data().ownerUid !== ownerUid) {
    throw new Error("Somente o proprietário pode excluir este quadro.");
  }

  const childCollections = ["tasks", "members", "invitations"];
  for (const collectionName of childCollections) {
    const snapshot = await getDocs(collection(db, "boards", boardId, collectionName));
    for (let offset = 0; offset < snapshot.docs.length; offset += 450) {
      const batch = writeBatch(db);
      snapshot.docs
        .slice(offset, offset + 450)
        .forEach((documentSnapshot) => batch.delete(documentSnapshot.ref));
      await batch.commit();
    }
  }

  const columnsSnapshot = await getDocs(collection(db, "boards", boardId, "columns"));
  if (columnsSnapshot.size + 1 > 500) {
    throw new Error("O quadro tem colunas demais para concluir a exclusão com segurança.");
  }

  const finalBatch = writeBatch(db);
  columnsSnapshot.docs.forEach((columnDocument) => finalBatch.delete(columnDocument.ref));
  finalBatch.delete(boardReference);
  await finalBatch.commit();
}

function mapLegacyTask(taskDocument) {
  const task = taskDocument.data();
  const columnId = task.columnId ?? task.status;
  if (typeof columnId !== "string" ||
      !DEFAULT_COLUMNS.some((column) => column.id === columnId)) {
    throw new Error(`A tarefa antiga "${taskDocument.id}" tem uma coluna ou status não reconhecido.`);
  }

  return {
    ...task,
    columnId
  };
}

function valuesEqual(left, right) {
  if (left === right) return true;
  if (typeof left === "number" && Number.isNaN(left) &&
      typeof right === "number" && Number.isNaN(right)) return true;
  if (left && typeof left.isEqual === "function") return left.isEqual(right);
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => valuesEqual(value, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        valuesEqual(left[key], right[key])
      );
  }
  return false;
}

async function acquireMigrationLease(db, userId, boardId) {
  const migrationReference = getMigrationReference(db, userId);
  const deadline = Date.now() + MIGRATION_WAIT_MS;

  while (Date.now() < deadline) {
    const result = await runTransaction(db, async (transaction) => {
      const migrationSnapshot = await transaction.get(migrationReference);
      const migration = migrationSnapshot.exists() ? migrationSnapshot.data() : null;

      if (migration && migration.state === "complete") {
        return { state: "complete" };
      }

      if (migration && migration.state === "running" &&
          toMillis(migration.leaseExpiresAt) > Date.now()) {
        return { state: "waiting" };
      }

      const token = crypto.randomUUID();
      transaction.set(migrationReference, {
        state: "running",
        boardId,
        leaseToken: token,
        leaseExpiresAt: Timestamp.fromMillis(Date.now() + MIGRATION_LEASE_MS),
        updatedAt: serverTimestamp()
      }, { merge: true });
      return { state: "acquired", token };
    });

    if (result.state !== "waiting") return result;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error("A migração inicial está ocupada em outra sessão. Tente novamente.");
}

function assertActiveLease(migration, token, boardId) {
  if (!migration || migration.state !== "running" ||
      migration.leaseToken !== token || migration.boardId !== boardId ||
      toMillis(migration.leaseExpiresAt) <= Date.now()) {
    throw new Error("A sessão perdeu o controle da migração; ela será retomada com segurança.");
  }
}

async function ensureInitialBoard(db, userId, boardId, token) {
  const boardReference = doc(db, "boards", boardId);
  const ownedBoards = await loadOwnedBoards(db, userId);
  const boardExists = ownedBoards.some((board) => board.id === boardId);
  const existingColumns = boardExists
    ? await loadBoardColumns(db, boardId)
    : [];
  const existingColumnIds = new Set(existingColumns.map((column) => column.id));
  const migrationReference = getMigrationReference(db, userId);

  await runTransaction(db, async (transaction) => {
    const migrationSnapshot = await transaction.get(migrationReference);
    const migration = migrationSnapshot.exists() ? migrationSnapshot.data() : null;
    assertActiveLease(migration, token, boardId);

    if (!boardExists) {
      transaction.set(boardReference, {
        name: INITIAL_BOARD_NAME,
        ownerUid: userId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    }

    DEFAULT_COLUMNS.forEach((column) => {
      if (!existingColumnIds.has(column.id)) {
        transaction.set(doc(boardReference, "columns", column.id), {
          name: column.name,
          order: column.order,
          createdAt: serverTimestamp()
        });
      }
    });

    assertActiveLease(migration, token, boardId);
    transaction.update(migrationReference, {
      leaseExpiresAt: Timestamp.fromMillis(Date.now() + MIGRATION_LEASE_MS),
      updatedAt: serverTimestamp()
    });
  });
}

async function renewLeaseAndCopyChunk(db, userId, boardId, token, tasks) {
  const migrationReference = getMigrationReference(db, userId);

  await runTransaction(db, async (transaction) => {
    const migrationSnapshot = await transaction.get(migrationReference);
    const migration = migrationSnapshot.exists() ? migrationSnapshot.data() : null;
    assertActiveLease(migration, token, boardId);

    tasks.forEach(({ reference, data }) => transaction.set(reference, data));
    assertActiveLease(migration, token, boardId);
    transaction.update(migrationReference, {
      leaseExpiresAt: Timestamp.fromMillis(Date.now() + MIGRATION_LEASE_MS),
      updatedAt: serverTimestamp()
    });
  });
}

async function verifyMigratedTasks(db, boardId, legacyTasks) {
  const destination = await getDocs(collection(db, "boards", boardId, "tasks"));
  const migratedById = new Map(destination.docs.map((taskDocument) => [
    taskDocument.id,
    taskDocument.data()
  ]));

  for (const legacyTask of legacyTasks) {
    const expected = mapLegacyTask(legacyTask);
    const migrated = migratedById.get(legacyTask.id);
    if (!migrated || !valuesEqual(migrated, expected)) {
      throw new Error(`A verificação da tarefa "${legacyTask.id}" falhou.`);
    }
  }
}

async function releaseMigrationLease(db, userId, token) {
  const migrationReference = getMigrationReference(db, userId);
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(migrationReference);
    if (snapshot.exists() && snapshot.data().leaseToken === token) {
      transaction.set(migrationReference, {
        state: "pending",
        leaseToken: null,
        leaseExpiresAt: Timestamp.fromMillis(0),
        updatedAt: serverTimestamp()
      }, { merge: true });
    }
  });
}

export async function ensureInitialBoardAndMigrate(db, userId) {
  const boardId = getInitialBoardId(userId);
  const lease = await acquireMigrationLease(db, userId, boardId);
  if (lease.state === "complete") return boardId;

  try {
    await ensureInitialBoard(db, userId, boardId, lease.token);
    const legacySnapshot = await getDocs(collection(db, "users", userId, "tasks"));
    const migratedTasks = legacySnapshot.docs.map((taskDocument) => ({
      id: taskDocument.id,
      data: mapLegacyTask(taskDocument),
      reference: doc(db, "boards", boardId, "tasks", taskDocument.id)
    }));

    const destinationSnapshot = await getDocs(collection(db, "boards", boardId, "tasks"));
    const destinationById = new Map(destinationSnapshot.docs.map((taskDocument) => [
      taskDocument.id,
      taskDocument.data()
    ]));
    const tasksToCopy = migratedTasks.filter(({ id, data }) => {
      const existing = destinationById.get(id);
      if (existing && !valuesEqual(existing, data)) {
        throw new Error(`A tarefa de destino "${id}" já existe com dados diferentes; a migração foi interrompida para preservá-la.`);
      }
      return !existing;
    });

    for (let index = 0; index < tasksToCopy.length; index += MIGRATION_BATCH_SIZE) {
      await renewLeaseAndCopyChunk(
        db,
        userId,
        boardId,
        lease.token,
        tasksToCopy.slice(index, index + MIGRATION_BATCH_SIZE)
      );
    }

    await verifyMigratedTasks(db, boardId, legacySnapshot.docs);

    const migrationReference = getMigrationReference(db, userId);
    await runTransaction(db, async (transaction) => {
      const migrationSnapshot = await transaction.get(migrationReference);
      const migration = migrationSnapshot.exists() ? migrationSnapshot.data() : null;
      assertActiveLease(migration, lease.token, boardId);

      transaction.set(migrationReference, {
        state: "complete",
        boardId,
        taskCount: migratedTasks.length,
        completedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        leaseToken: null,
        leaseExpiresAt: Timestamp.fromMillis(0)
      }, { merge: true });
    });

    return boardId;
  } catch (error) {
    try {
      await releaseMigrationLease(db, userId, lease.token);
    } catch (releaseError) {
      console.error("Não foi possível liberar o controle da migração:", releaseError);
    }
    throw error;
  }
}
