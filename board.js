// Importa os serviços Firebase e as operações de sessão e dados do quadro.
import { auth, db } from "./firebase-config.js";
import {
  onAuthStateChanged,
  EmailAuthProvider,
  reauthenticateWithCredential,
  reload,
  signOut,
  updatePassword,
  updateProfile,
  verifyBeforeUpdateEmail
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getAuthErrorMessage } from "./auth.js";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  createBoard,
  createBoardInvitation,
  ensureInitialBoardAndMigrate,
  loadBoardInvitations,
  loadAccessibleBoards,
  loadBoardColumns,
  loadBoardMembers,
  loadReceivedInvitations,
  cancelBoardInvitation,
  removeBoardMember,
  respondToBoardInvitation,
  updateBoardMemberRole
} from "./board-store.js";

let currentUser = null;
let currentBoard = null;
let boards = [];
let columns = [];
const boardElement = document.querySelector("#board-columns");
const boardSelector = document.querySelector("#board-selector");
const activeBoardName = document.querySelector("#active-board-name");
const activeBoardRole = document.querySelector("#active-board-role");
const createBoardButton = document.querySelector("#create-board-button");
const shareBoardButton = document.querySelector("#share-board-button");
const editAccountButton = document.querySelector("#edit-account-button");
// Referências aos formulários, caixas de diálogo e avisos acessíveis do quadro.
const dialog = document.querySelector("#task-dialog");
const taskForm = document.querySelector("#task-form");
const announcement = document.querySelector("#board-announcement");
const boardStatus = document.querySelector("#board-status");
const deleteDialog = document.querySelector("#delete-dialog");
const deleteMessage = document.querySelector("#delete-confirmation-message");
const boardDialog = document.querySelector("#board-dialog");
const boardForm = document.querySelector("#board-form");
const boardFormMessage = document.querySelector("#board-form-message");
const boardSubmitButton = document.querySelector("#board-submit");
const shareDialog = document.querySelector("#share-dialog");
const shareForm = document.querySelector("#share-form");
const shareInviteMessage = document.querySelector("#share-invite-message");
const shareMembersStatus = document.querySelector("#share-members-status");
const memberList = document.querySelector("#member-list");
const pendingInvitationList = document.querySelector("#pending-invitation-list");
const shareInvitationsStatus = document.querySelector("#share-invitations-status");
const receivedInvitationsButton = document.querySelector("#received-invitations-button");
const receivedInvitationsDialog = document.querySelector("#received-invitations-dialog");
const receivedInvitationsList = document.querySelector("#received-invitations-list");
const receivedInvitationsStatus = document.querySelector("#received-invitations-status");
let receivedInvitations = [];
// Guarda os identificadores temporários usados ao arrastar, editar e excluir tarefas.
let draggedTaskId = null;
let editingTaskId = null;
let pendingDeleteTaskId = null;
let boardReady = false;

// Constrói a coleção de tarefas dentro do quadro ativo.
function tasksCollection(boardId = currentBoard.id) {
  return collection(db, "boards", boardId, "tasks");
}

function canEditTasks() {
  return currentBoard?.role === "owner" || currentBoard?.role === "editor";
}

function canManageMembers() {
  return Boolean(currentUser &&
    currentBoard?.role === "owner" &&
    currentBoard.ownerUid === currentUser.uid);
}

function syncShareButton() {
  shareBoardButton.hidden = !canManageMembers();
}

function syncReceivedInvitationsButton() {
  receivedInvitationsButton.hidden = !currentUser;
}

async function getVerifiedInvitationUser() {
  if (!currentUser) {
    throw new Error("Entre na sua conta para acessar os convites.");
  }

  await reload(currentUser);
  if (!currentUser.email || !currentUser.emailVerified) {
    throw new Error("Verifique o e-mail da sua conta antes de consultar ou aceitar convites.");
  }

  await currentUser.getIdToken(true);
  return currentUser;
}

function getRoleLabel(role) {
  return {
    owner: "Proprietário",
    editor: "Editor",
    reader: "Leitor"
  }[role] || "Sem permissão";
}

// Confere se cada registro salvo contém os campos e status aceitos pelo quadro.
function isValidTask(task) {
  return task &&
    typeof task.id === "string" &&
    typeof task.title === "string" &&
    typeof task.columnId === "string" &&
    columns.some((column) => column.dataset.columnId === task.columnId);
}

// Mantém em memória os documentos carregados para o usuário autenticado.
let tasks = [];

// Busca os documentos da coleção do quadro ativo.
async function loadTasks() {
  const snapshot = await getDocs(tasksCollection());
  const loadedTasks = snapshot.docs.map((taskDocument) => ({
    ...taskDocument.data(),
    id: taskDocument.id
  }));
  if (!loadedTasks.every(isValidTask)) {
    throw new Error("O Firestore contém dados de tarefa em formato inválido.");
  }
  tasks = loadedTasks.map((task) => ({
    ...task,
    description: typeof task.description === "string" ? task.description : ""
  }));
  renderBoard();
}

function setTaskActionsEnabled(enabled) {
  boardReady = enabled;
  const canEdit = enabled && canEditTasks();
  document.querySelectorAll(".column-add-task").forEach((button) => {
    button.disabled = !canEdit;
  });
  boardElement.classList.toggle("is-read-only", enabled && !canEdit);
}

function setBoardControlsEnabled(enabled) {
  boardSelector.disabled = !enabled;
  createBoardButton.disabled = !enabled;
  editAccountButton.disabled = !enabled;
}

function selectedBoardStorageKey(userId) {
  return `kanban.activeBoard.${userId}`;
}

function saveSelectedBoard(boardId) {
  try {
    localStorage.setItem(selectedBoardStorageKey(currentUser.uid), boardId);
    return true;
  } catch (error) {
    console.error("Não foi possível salvar o quadro selecionado neste navegador:", error);
    return false;
  }
}

function getPreferredBoard(availableBoards, userId) {
  try {
    const savedBoardId = localStorage.getItem(selectedBoardStorageKey(userId));
    const savedBoard = availableBoards.find((board) => board.id === savedBoardId);
    if (savedBoard) return savedBoard;
  } catch (error) {
    console.error("Não foi possível ler o quadro salvo neste navegador:", error);
  }

  return availableBoards[0] || null;
}

function renderBoardSelector() {
  boardSelector.replaceChildren();
  boards.forEach((board) => {
    const option = document.createElement("option");
    option.value = board.id;
    option.textContent = board.name;
    boardSelector.append(option);
  });
  boardSelector.disabled = boards.length === 0;
  if (currentBoard) boardSelector.value = currentBoard.id;
}

async function openBoard(board, rememberSelection = true) {
  const previousBoardId = currentBoard?.id;
  currentBoard = board;
  if (shareDialog.open && previousBoardId !== board.id) closeShareDialog();
  syncShareButton();
  activeBoardName.textContent = board.name;
  activeBoardRole.textContent = getRoleLabel(board.role);
  activeBoardRole.dataset.role = board.role;
  boardSelector.value = board.id;
  setBoardControlsEnabled(false);
  setTaskActionsEnabled(false);
  boardStatus.classList.remove("is-error");
  boardStatus.textContent = "Carregando o quadro...";

  const selectionSaved = !rememberSelection || saveSelectedBoard(board.id);

  try {
    const boardColumns = await loadBoardColumns(db, board.id);
    if (boardColumns.length === 0) {
      throw new Error("O quadro não possui colunas configuradas.");
    }

    renderColumns(boardColumns);
    tasks = [];
    renderBoard();
    await loadTasks();
    boardStatus.textContent = selectionSaved
      ? ""
      : "O quadro foi aberto, mas não será lembrado neste navegador.";
    boardStatus.classList.toggle("is-error", !selectionSaved);
    setTaskActionsEnabled(true);
  } catch (error) {
    console.error("Erro ao carregar o quadro selecionado:", error);
    boardStatus.textContent = error.code === "permission-denied"
      ? "Você não tem permissão para acessar este quadro."
      : error.message || "Não foi possível carregar o quadro. Verifique a conexão.";
    boardStatus.classList.add("is-error");
    announcement.textContent = boardStatus.textContent;
  }

  setBoardControlsEnabled(true);
  renderBoardSelector();
}

// Mostra falhas de persistência no quadro e no console.
function reportFirestoreError(action, error) {
  console.error(`Erro ao ${action} no Firestore:`, error);
  const reason = error.code === "permission-denied"
    ? "O Firestore negou o acesso. Publique as regras do arquivo firestore.rules no projeto Firebase."
    : error.code === "unavailable"
      ? "O Firebase está indisponível. Verifique sua conexão com a internet."
      : error.code === "not-found"
        ? "O banco Firestore ainda não foi criado neste projeto."
        : "Confira a conexão e as configurações do Firebase.";
  const message = `Não foi possível ${action} a tarefa. ${reason}`;
  announcement.textContent = message;
  boardStatus.textContent = message;
  boardStatus.classList.add("is-error");
}

// Cria os elementos HTML e ações de um cartão de tarefa sem inserir HTML não confiável.
function createTaskCard(task) {
  // Cria o cartão e registra atributos usados por acessibilidade e arraste.
  const card = document.createElement("article");
  card.className = "task-card";
  card.draggable = canEditTasks();
  card.tabIndex = 0;
  card.dataset.taskId = task.id;
  card.setAttribute(
    "aria-label",
    canEditTasks()
      ? `${task.title}. Arraste para mover entre colunas.`
      : `${task.title}. Somente leitura.`
  );

  // Cria e insere o título da tarefa como texto.
  const title = document.createElement("h3");
  title.textContent = task.title;

  card.append(title);

  // Só cria o parágrafo de descrição quando há conteúdo.
  if (task.description) {
    const description = document.createElement("p");
    description.className = "task-description";
    description.textContent = task.description;
    card.append(description);
  }

  if (canEditTasks()) {
    const actions = document.createElement("div");
    actions.className = "task-actions";
    const editButton = document.createElement("button");
    editButton.className = "task-action-button";
    editButton.type = "button";
    editButton.textContent = "Editar";
    editButton.setAttribute("aria-label", `Editar tarefa: ${task.title}`);
    editButton.addEventListener("click", () => openEditForm(task.id));

    const deleteButton = document.createElement("button");
    deleteButton.className = "task-action-button task-delete-button";
    deleteButton.type = "button";
    deleteButton.textContent = "Excluir";
    deleteButton.setAttribute("aria-label", `Excluir tarefa: ${task.title}`);
    deleteButton.addEventListener("click", () => deleteTask(task.id));
    actions.append(editButton, deleteButton);
    card.append(actions);
  }

  // Inicia o arraste apenas a partir do cartão, não dos botões internos.
  card.addEventListener("dragstart", (event) => {
    if (!canEditTasks() || event.target.closest("button")) {
      event.preventDefault();
      return;
    }
    draggedTaskId = task.id;
    card.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", task.title);
  });

  // Remove o estado visual de arraste e limpa classes quando o movimento termina.
  card.addEventListener("dragend", () => {
    card.classList.remove("is-dragging");
    columns.forEach((column) => column.classList.remove("is-over"));
    draggedTaskId = null;
  });

  // Devolve o cartão já montado para ser inserido em sua coluna.
  return card;
}

function bindColumnEvents(column) {
  column.addEventListener("dragover", (event) => {
    if (!canEditTasks() || !draggedTaskId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    column.classList.add("is-over");
  });

  column.addEventListener("dragleave", (event) => {
    if (!column.contains(event.relatedTarget)) column.classList.remove("is-over");
  });

  column.addEventListener("drop", (event) => {
    event.preventDefault();
    if (canEditTasks() && draggedTaskId) {
      const card = [...document.querySelectorAll(".task-card")]
        .find((item) => item.dataset.taskId === draggedTaskId);
      if (card) void moveTask(card, column);
    }
    column.classList.remove("is-over");
  });
}

function renderColumns(boardColumns) {
  boardElement.replaceChildren();
  columns = boardColumns.map((boardColumn, index) => {
    const column = document.createElement("section");
    column.className = "board-column";
    column.dataset.columnId = boardColumn.id;
    column.setAttribute("aria-labelledby", `column-heading-${index}`);

    const header = document.createElement("header");
    header.className = "column-header";
    const titleWrap = document.createElement("div");
    titleWrap.className = "column-title-wrap";
    const indicator = document.createElement("span");
    indicator.className = "column-indicator";
    if (["todo", "progress", "review", "done"].includes(boardColumn.id)) {
      indicator.classList.add(`indicator-${boardColumn.id}`);
    }
    const heading = document.createElement("h2");
    heading.id = `column-heading-${index}`;
    heading.textContent = boardColumn.name;
    titleWrap.append(indicator, heading);

    const count = document.createElement("span");
    count.className = "task-count";
    count.textContent = "0";
    count.setAttribute("aria-label", "0 tarefas");
    header.append(titleWrap, count);

    const addButton = document.createElement("button");
    addButton.className = "column-add-task";
    addButton.type = "button";
    addButton.dataset.columnId = boardColumn.id;
    addButton.disabled = !boardReady || !canEditTasks();
    addButton.append(document.createElement("span"));
    addButton.firstElementChild.setAttribute("aria-hidden", "true");
    addButton.firstElementChild.textContent = "+";
    addButton.append(document.createTextNode(" Nova Tarefa"));
    addButton.addEventListener("click", openTaskForm);

    const cardList = document.createElement("div");
    cardList.className = "card-list";
    cardList.setAttribute("aria-label", `Tarefas em ${boardColumn.name}`);
    column.append(header, addButton, cardList);
    bindColumnEvents(column);
    boardElement.append(column);
    return column;
  });
}

// Atualiza os contadores visíveis e seus rótulos acessíveis em cada coluna.
function updateTaskCounts() {
  columns.forEach((column) => {
    const count = column.querySelector(".card-list").children.length;
    const counter = column.querySelector(".task-count");
    counter.textContent = count;
    counter.setAttribute("aria-label", `${count} ${count === 1 ? "tarefa" : "tarefas"}`);
  });
}

// Reconstrói o conteúdo de cada coluna com base no estado atual das tarefas.
function renderBoard() {
  columns.forEach((column) => {
    const cardList = column.querySelector(".card-list");
    cardList.replaceChildren();
    tasks
      .filter((task) => task.columnId === column.dataset.columnId)
      .forEach((task) => cardList.append(createTaskCard(task)));
  });
  updateTaskCounts();
}

// Move a tarefa para outra coluna, salva a mudança e anuncia o resultado.
async function moveTask(card, column) {
  if (!boardReady || !canEditTasks()) return;
  const task = tasks.find((item) => item.id === card.dataset.taskId);
  if (!task || task.columnId === column.dataset.columnId) return;

  const updates = {
    columnId: column.dataset.columnId,
    updatedAt: serverTimestamp()
  };
  if (Object.prototype.hasOwnProperty.call(task, "status")) {
    updates.status = column.dataset.columnId;
  }

  try {
    await updateDoc(doc(tasksCollection(), task.id), updates);
  } catch (error) {
    reportFirestoreError("mover", error);
    return;
  }

  task.columnId = column.dataset.columnId;
  if (Object.prototype.hasOwnProperty.call(task, "status")) {
    task.status = column.dataset.columnId;
  }
  renderBoard();
  const heading = column.querySelector("h2").textContent;
  announcement.textContent = `Tarefa movida para ${heading}.`;
}

// Desenha o quadro na primeira carga da página.
renderBoard();

// Prepara o formulário para adicionar tarefa na coluna acionada.
function openTaskForm(event) {
  if (!boardReady || !canEditTasks()) return;
  editingTaskId = null;
  taskForm.reset();
  taskForm.dataset.mode = "create";
  taskForm.dataset.columnId = event.currentTarget.dataset.columnId;
  document.querySelector("#dialog-title").textContent = "Adicionar tarefa";
  document.querySelector("#task-submit").textContent = "Adicionar tarefa";
  dialog.showModal();
  document.querySelector("#task-title").focus();
}

// Preenche o formulário com os dados existentes para permitir a edição.
function openEditForm(taskId) {
  if (!boardReady || !canEditTasks()) return;
  const task = tasks.find((item) => item.id === taskId);
  if (!task) return;

  editingTaskId = taskId;
  taskForm.dataset.mode = "edit";
  document.querySelector("#dialog-title").textContent = "Editar tarefa";
  document.querySelector("#task-submit").textContent = "Salvar alterações";
  document.querySelector("#task-title").value = task.title;
  document.querySelector("#task-description").value = task.description || "";
  dialog.showModal();
  document.querySelector("#task-title").focus();
}

// Abre uma confirmação visual antes de excluir a tarefa selecionada.
function deleteTask(taskId) {
  if (!boardReady || !canEditTasks()) return;
  const task = tasks.find((item) => item.id === taskId);
  if (!task) return;

  pendingDeleteTaskId = taskId;
  deleteMessage.textContent = `Tem certeza de que deseja excluir “${task.title}”? Esta ação não pode ser desfeita.`;
  deleteDialog.showModal();
  document.querySelector("#cancel-delete").focus();
}

// Exclui a tarefa confirmada e atualiza o quadro.
async function confirmDeleteTask() {
  if (!boardReady || !canEditTasks()) {
    closeDeleteDialog();
    return;
  }
  const task = tasks.find((item) => item.id === pendingDeleteTaskId);
  if (!task) {
    closeDeleteDialog();
    return;
  }

  try {
    await deleteDoc(doc(tasksCollection(), task.id));
  } catch (error) {
    reportFirestoreError("excluir", error);
    return;
  }

  tasks = tasks.filter((item) => item.id !== task.id);
  renderBoard();
  announcement.textContent = `Tarefa "${task.title}" excluída.`;
  closeDeleteDialog();
}

// Fecha a confirmação e limpa o identificador pendente.
function closeDeleteDialog() {
  deleteDialog.close();
  pendingDeleteTaskId = null;
  deleteMessage.textContent = "";
}

// Fecha e limpa o formulário de tarefa sem salvar alterações.
function closeDialog() {
  dialog.close();
  taskForm.reset();
  editingTaskId = null;
}

// Associa os controles de fechar e cancelar do formulário de tarefa.
document.querySelector("#close-task-form").addEventListener("click", closeDialog);
document.querySelector("#cancel-task-form").addEventListener("click", closeDialog);

// Valida e processa o formulário para criar uma tarefa ou salvar uma edição.
taskForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!boardReady || !canEditTasks()) return;
  if (!taskForm.reportValidity()) return;

  // Lê e limpa os campos enviados pelo formulário.
  const formData = new FormData(taskForm);
  const title = formData.get("title").trim();
  const description = formData.get("description").trim();

  if (!title) return;

  // Atualiza uma tarefa existente quando o formulário está em modo de edição.
  if (taskForm.dataset.mode === "edit" && editingTaskId) {
    const task = tasks.find((item) => item.id === editingTaskId);
    if (!task) return;
    try {
      await updateDoc(doc(tasksCollection(), task.id), {
        title,
        description,
        updatedAt: serverTimestamp()
      });
    } catch (error) {
      reportFirestoreError("atualizar", error);
      return;
    }

    task.title = title;
    task.description = description;
    renderBoard();
    announcement.textContent = `Tarefa "${title}" atualizada.`;
    closeDialog();
    return;
  }

  // Para uma nova tarefa, confirma que o status selecionado corresponde a uma coluna.
  const column = columns.find((item) => item.dataset.columnId === taskForm.dataset.columnId);
  if (!title || !column) return;

  // Cria um identificador único e adiciona a tarefa ao estado do quadro.
  const newTask = {
    title,
    description,
    columnId: taskForm.dataset.columnId,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
  let newTaskReference;
  try {
    newTaskReference = await addDoc(tasksCollection(), newTask);
  } catch (error) {
    reportFirestoreError("adicionar", error);
    return;
  }

  tasks.push({ ...newTask, id: newTaskReference.id });
  renderBoard();
  announcement.textContent = `Tarefa "${title}" adicionada em ${column.querySelector("h2").textContent}.`;
  closeDialog();
});

// Fecha o formulário quando o usuário clica no fundo da janela modal.
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) closeDialog();
});

// Liga os botões da confirmação de exclusão às ações correspondentes.
document.querySelector("#confirm-delete").addEventListener("click", confirmDeleteTask);
document.querySelector("#cancel-delete").addEventListener("click", closeDeleteDialog);
document.querySelector("#close-delete-dialog").addEventListener("click", closeDeleteDialog);

// Fecha a confirmação ao clicar fora dela.
deleteDialog.addEventListener("click", (event) => {
  if (event.target === deleteDialog) closeDeleteDialog();
});

// Limpa a confirmação também quando a janela é fechada pelo teclado.
deleteDialog.addEventListener("close", () => {
  pendingDeleteTaskId = null;
  deleteMessage.textContent = "";
});

function openBoardDialog() {
  boardForm.reset();
  boardFormMessage.textContent = "";
  if (!boardForm.dataset.newBoardId) {
    boardForm.dataset.newBoardId = doc(collection(db, "boards")).id;
  }
  boardDialog.showModal();
  document.querySelector("#board-name").focus();
}

function closeBoardDialog() {
  boardDialog.close();
  boardForm.reset();
  boardFormMessage.textContent = "";
}

function setShareMessage(element, message, isError = false, isSuccess = false) {
  element.textContent = message;
  element.classList.toggle("is-error", isError);
  element.classList.toggle("is-success", isSuccess);
}

function getMemberOperationError(error, action) {
  if (error.code === "permission-denied") {
    return "O Firestore negou a operação. As regras atualizadas de compartilhamento precisam estar publicadas.";
  }
  if (error.code === "not-found") {
    return "O membro não foi encontrado. Atualize a lista e tente novamente.";
  }
  return error.message || `Não foi possível ${action}. Tente novamente.`;
}

function renderMemberList(members) {
  memberList.replaceChildren();

  members.forEach((member) => {
    const row = document.createElement("li");
    row.className = "member-row";

    const details = document.createElement("div");
    details.className = "member-details";
    const identity = document.createElement("span");
    identity.className = "member-identity";
    identity.textContent = member.isOwner && currentUser?.uid === member.uid
      ? currentUser.email || member.uid
      : `UID: ${member.uid}`;
    details.append(identity);

    if (member.isOwner) {
      const ownerRole = document.createElement("span");
      ownerRole.className = "member-role member-role-owner";
      ownerRole.textContent = "Proprietário";
      details.append(ownerRole);
      row.append(details);
      memberList.append(row);
      return;
    }

    const actions = document.createElement("div");
    actions.className = "member-actions";
    const roleSelect = document.createElement("select");
    roleSelect.className = "member-role-select";
    roleSelect.setAttribute("aria-label", `Papel do membro ${member.uid}`);
    [
      { value: "editor", label: "Editor" },
      { value: "reader", label: "Leitor" }
    ].forEach(({ value, label }) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      roleSelect.append(option);
    });
    roleSelect.value = member.role;
    roleSelect.dataset.originalRole = member.role;

    const saveButton = document.createElement("button");
    saveButton.className = "share-action-button";
    saveButton.type = "button";
    saveButton.textContent = "Salvar";
    saveButton.disabled = true;
    roleSelect.addEventListener("change", () => {
      saveButton.disabled = roleSelect.value === roleSelect.dataset.originalRole;
    });
    saveButton.addEventListener("click", () => {
      void saveMemberRole(member.uid, roleSelect, saveButton);
    });

    const removeButton = document.createElement("button");
    removeButton.className = "share-action-button member-remove-button";
    removeButton.type = "button";
    removeButton.textContent = "Remover";
    removeButton.setAttribute("aria-label", `Remover acesso de ${member.uid}`);
    removeButton.addEventListener("click", () => {
      void removeMemberAccess(member.uid, removeButton);
    });

    actions.append(roleSelect, saveButton, removeButton);
    row.append(details, actions);
    memberList.append(row);
  });
}

async function refreshBoardMembers(successMessage = "") {
  if (!canManageMembers() || !currentBoard) return;
  const board = currentBoard;
  setShareMessage(shareMembersStatus, "Carregando membros...");
  memberList.replaceChildren();
  renderMemberList([{ uid: board.ownerUid, role: "owner", isOwner: true }]);

  try {
    const members = await loadBoardMembers(db, board.id, board.ownerUid);
    if (!shareDialog.open || currentBoard?.id !== board.id) return;

    renderMemberList(members);
    setShareMessage(
      shareMembersStatus,
      successMessage || (members.length > 1
        ? ""
        : "Nenhum editor ou leitor tem acesso a este quadro."),
      false,
      Boolean(successMessage)
    );
  } catch (error) {
    console.error("Erro ao carregar membros do quadro:", error);
    if (!shareDialog.open || currentBoard?.id !== board.id) return;
    setShareMessage(
      shareMembersStatus,
      getMemberOperationError(error, "carregar os membros"),
      true
    );
  }
}

function formatInvitationDate(value) {
  const date = value && typeof value.toDate === "function" ? value.toDate() : null;
  return date
    ? new Intl.DateTimeFormat("pt-BR", {
      dateStyle: "short",
      timeStyle: "short"
    }).format(date)
    : "Data indisponível";
}

function renderPendingInvitations(invitations) {
  pendingInvitationList.replaceChildren();

  invitations.forEach((invitation) => {
    const row = document.createElement("li");
    row.className = "member-row";
    const details = document.createElement("div");
    details.className = "member-details";

    const identity = document.createElement("span");
    identity.className = "member-identity";
    identity.textContent = invitation.email;
    const role = document.createElement("span");
    role.className = "member-role";
    role.textContent = `${getRoleLabel(invitation.role)} · enviado ${formatInvitationDate(invitation.createdAt)}`;
    details.append(identity, role);

    const cancelButton = document.createElement("button");
    cancelButton.className = "share-action-button member-remove-button";
    cancelButton.type = "button";
    cancelButton.textContent = "Cancelar convite";
    cancelButton.addEventListener("click", () => {
      void cancelPendingInvitation(invitation, cancelButton);
    });

    const actions = document.createElement("div");
    actions.className = "member-actions";
    actions.append(cancelButton);
    row.append(details, actions);
    pendingInvitationList.append(row);
  });
}

async function refreshPendingInvitations(successMessage = "") {
  if (!canManageMembers() || !currentBoard) return;
  const board = currentBoard;
  setShareMessage(shareInvitationsStatus, "Carregando convites...");
  pendingInvitationList.replaceChildren();

  try {
    const invitations = await loadBoardInvitations(db, board.id, board.ownerUid);
    if (!shareDialog.open || currentBoard?.id !== board.id) return;

    renderPendingInvitations(invitations);
    setShareMessage(
      shareInvitationsStatus,
      successMessage || (invitations.length
        ? ""
        : "Nenhum convite pendente."),
      false,
      Boolean(successMessage)
    );
  } catch (error) {
    console.error("Erro ao carregar convites do quadro:", error);
    if (!shareDialog.open || currentBoard?.id !== board.id) return;
    setShareMessage(
      shareInvitationsStatus,
      getMemberOperationError(error, "carregar os convites"),
      true
    );
  }
}

async function cancelPendingInvitation(invitation, cancelButton) {
  if (!canManageMembers() || !currentBoard ||
      invitation.boardId !== currentBoard.id) return;

  if (!window.confirm(`Cancelar o convite enviado para ${invitation.email}?`)) return;
  cancelButton.disabled = true;
  setShareMessage(shareInvitationsStatus, "Cancelando o convite...");

  try {
    await cancelBoardInvitation(
      db,
      invitation.boardId,
      invitation.id,
      currentBoard.ownerUid
    );
    await refreshPendingInvitations("Convite cancelado.");
  } catch (error) {
    console.error("Erro ao cancelar convite:", error);
    cancelButton.disabled = false;
    setShareMessage(
      shareInvitationsStatus,
      getMemberOperationError(error, "cancelar o convite"),
      true
    );
  }
}

function renderReceivedInvitations() {
  receivedInvitationsList.replaceChildren();

  receivedInvitations.forEach((invitation) => {
    const row = document.createElement("li");
    row.className = "member-row received-invitation-row";
    const details = document.createElement("div");
    details.className = "member-details";

    const boardName = document.createElement("span");
    boardName.className = "member-identity";
    boardName.textContent = invitation.boardName;
    const sender = document.createElement("span");
    sender.className = "invitation-metadata";
    sender.textContent = `Enviado pelo UID ${invitation.ownerUid}`;
    const role = document.createElement("span");
    role.className = "member-role";
    role.textContent = `${getRoleLabel(invitation.role)} · ${formatInvitationDate(invitation.createdAt)}`;
    details.append(boardName, sender, role);

    const actions = document.createElement("div");
    actions.className = "member-actions";
    const acceptButton = document.createElement("button");
    acceptButton.className = "share-action-button invitation-accept-button";
    acceptButton.type = "button";
    acceptButton.textContent = "Aceitar";
    const declineButton = document.createElement("button");
    declineButton.className = "share-action-button member-remove-button";
    declineButton.type = "button";
    declineButton.textContent = "Recusar";
    acceptButton.addEventListener("click", () => {
      void respondToInvitation(invitation, "accepted", [acceptButton, declineButton]);
    });
    declineButton.addEventListener("click", () => {
      void respondToInvitation(invitation, "declined", [acceptButton, declineButton]);
    });
    actions.append(acceptButton, declineButton);
    row.append(details, actions);
    receivedInvitationsList.append(row);
  });
}

async function refreshReceivedInvitations(successMessage = "") {
  if (!currentUser) return;
  setShareMessage(receivedInvitationsStatus, "Carregando convites...");
  receivedInvitationsList.replaceChildren();

  try {
    const user = await getVerifiedInvitationUser();
    const invitations = await loadReceivedInvitations(db, user.email);
    if (!receivedInvitationsDialog.open || currentUser?.uid !== user.uid) return;

    receivedInvitations = invitations;
    renderReceivedInvitations();
    setShareMessage(
      receivedInvitationsStatus,
      successMessage || (invitations.length
        ? ""
        : "Você não tem convites pendentes para este e-mail."),
      false,
      Boolean(successMessage)
    );
  } catch (error) {
    console.error("Erro ao carregar convites recebidos:", error);
    if (!receivedInvitationsDialog.open) return;
    receivedInvitations = [];
    receivedInvitationsList.replaceChildren();
    setShareMessage(
      receivedInvitationsStatus,
      error.message || "Não foi possível carregar os convites recebidos.",
      true
    );
  }
}

async function respondToInvitation(invitation, response, actionButtons) {
  if (!currentUser) return;
  actionButtons.forEach((button) => {
    button.disabled = true;
  });
  setShareMessage(
    receivedInvitationsStatus,
    response === "accepted" ? "Aceitando o convite..." : "Recusando o convite..."
  );

  try {
    const user = await getVerifiedInvitationUser();
    await respondToBoardInvitation(db, user, invitation, response);
    receivedInvitations = receivedInvitations.filter((item) =>
      item.id !== invitation.id || item.boardId !== invitation.boardId
    );
    renderReceivedInvitations();

    if (response === "declined") {
      setShareMessage(receivedInvitationsStatus, "Convite recusado.", false, true);
      return;
    }

    try {
      boards = await loadAccessibleBoards(db, user.uid);
      renderBoardSelector();
      const acceptedBoard = boards.find((board) => board.id === invitation.boardId);
      if (!acceptedBoard) {
        throw new Error("O quadro aceito não apareceu na lista de quadros acessíveis.");
      }

      receivedInvitationsDialog.close();
      await openBoard(acceptedBoard);
      announcement.textContent = `Convite aceito. O quadro ${acceptedBoard.name} está aberto.`;
    } catch (error) {
      console.error("Convite aceito, mas não foi possível atualizar os quadros:", error);
      setShareMessage(
        receivedInvitationsStatus,
        "Convite aceito, mas não foi possível atualizar seus quadros. Recarregue a página.",
        true
      );
    }
  } catch (error) {
    console.error("Erro ao responder ao convite:", error);
    setShareMessage(
      receivedInvitationsStatus,
      getMemberOperationError(error, response === "accepted"
        ? "aceitar o convite"
        : "recusar o convite"),
      true
    );
    actionButtons.forEach((button) => {
      button.disabled = false;
    });
  }
}

async function saveMemberRole(memberUid, roleSelect, saveButton) {
  if (!canManageMembers() || !currentBoard) return;
  const board = currentBoard;
  roleSelect.disabled = true;
  saveButton.disabled = true;
  setShareMessage(shareMembersStatus, "Salvando o papel do membro...");

  try {
    await updateBoardMemberRole(db, board.id, board.ownerUid, memberUid, roleSelect.value);
    if (!shareDialog.open || currentBoard?.id !== board.id) return;
    await refreshBoardMembers("Papel do membro atualizado.");
  } catch (error) {
    console.error("Erro ao atualizar o papel do membro:", error);
    if (!shareDialog.open || currentBoard?.id !== board.id) return;
    roleSelect.disabled = false;
    saveButton.disabled = roleSelect.value === roleSelect.dataset.originalRole;
    setShareMessage(
      shareMembersStatus,
      getMemberOperationError(error, "atualizar o papel do membro"),
      true
    );
  }
}

async function removeMemberAccess(memberUid, removeButton) {
  if (!canManageMembers() || !currentBoard) return;
  if (!window.confirm(`Remover o acesso do membro ${memberUid}?`)) return;

  const board = currentBoard;
  removeButton.disabled = true;
  setShareMessage(shareMembersStatus, "Removendo o acesso do membro...");
  try {
    await removeBoardMember(db, board.id, board.ownerUid, memberUid);
    if (!shareDialog.open || currentBoard?.id !== board.id) return;
    await refreshBoardMembers("Acesso do membro removido.");
  } catch (error) {
    console.error("Erro ao remover membro do quadro:", error);
    if (!shareDialog.open || currentBoard?.id !== board.id) return;
    removeButton.disabled = false;
    setShareMessage(
      shareMembersStatus,
      getMemberOperationError(error, "remover o acesso do membro"),
      true
    );
  }
}

function openShareDialog() {
  if (!canManageMembers()) return;
  shareForm.reset();
  setShareMessage(shareInviteMessage, "");
  setShareMessage(shareMembersStatus, "");
  setShareMessage(shareInvitationsStatus, "");
  shareDialog.showModal();
  void refreshBoardMembers();
  void refreshPendingInvitations();
}

function closeShareDialog() {
  if (shareDialog.open) shareDialog.close();
  shareForm.reset();
  memberList.replaceChildren();
  pendingInvitationList.replaceChildren();
  setShareMessage(shareInviteMessage, "");
  setShareMessage(shareMembersStatus, "");
  setShareMessage(shareInvitationsStatus, "");
}

function openReceivedInvitationsDialog() {
  if (!currentUser) return;
  receivedInvitations = [];
  renderReceivedInvitations();
  setShareMessage(receivedInvitationsStatus, "");
  receivedInvitationsDialog.showModal();
  void refreshReceivedInvitations();
}

function closeReceivedInvitationsDialog() {
  if (receivedInvitationsDialog.open) receivedInvitationsDialog.close();
}

async function submitShareInvitation(event) {
  event.preventDefault();
  if (!canManageMembers() || !shareForm.reportValidity()) return;

  const submitButton = shareForm.querySelector('[type="submit"]');
  const email = document.querySelector("#share-email").value;
  const role = document.querySelector("#share-role").value;
  const board = currentBoard;
  if (currentUser.email &&
      email.trim().toLowerCase() === currentUser.email.toLowerCase()) {
    setShareMessage(
      shareInviteMessage,
      "Você já é proprietário deste quadro e não precisa convidar a própria conta.",
      true
    );
    return;
  }

  submitButton.disabled = true;
  setShareMessage(shareInviteMessage, "Criando convite...");

  try {
    await createBoardInvitation(db, board, currentUser.uid, email, role);
    shareForm.reset();
    setShareMessage(
      shareInviteMessage,
      "Convite criado. Ele aguarda a aceitação e ainda não concede acesso ao quadro.",
      false,
      true
    );
    await refreshPendingInvitations("Convite criado e aguardando aceitação.");
  } catch (error) {
    console.error("Erro ao criar convite para o quadro:", error);
    setShareMessage(
      shareInviteMessage,
      getMemberOperationError(error, "criar o convite"),
      true
    );
  } finally {
    submitButton.disabled = false;
  }
}

createBoardButton.addEventListener("click", openBoardDialog);
document.querySelector("#close-board-dialog").addEventListener("click", closeBoardDialog);
document.querySelector("#cancel-board-form").addEventListener("click", closeBoardDialog);
boardDialog.addEventListener("click", (event) => {
  if (event.target === boardDialog) closeBoardDialog();
});

shareBoardButton.addEventListener("click", openShareDialog);
document.querySelector("#close-share-dialog").addEventListener("click", closeShareDialog);
shareDialog.addEventListener("click", (event) => {
  if (event.target === shareDialog) closeShareDialog();
});
shareDialog.addEventListener("close", () => {
  shareForm.reset();
  memberList.replaceChildren();
  pendingInvitationList.replaceChildren();
  setShareMessage(shareInviteMessage, "");
  setShareMessage(shareMembersStatus, "");
  setShareMessage(shareInvitationsStatus, "");
});
shareForm.addEventListener("submit", (event) => {
  void submitShareInvitation(event);
});

receivedInvitationsButton.addEventListener("click", openReceivedInvitationsDialog);
document.querySelector("#close-received-invitations").addEventListener(
  "click",
  closeReceivedInvitationsDialog
);
receivedInvitationsDialog.addEventListener("click", (event) => {
  if (event.target === receivedInvitationsDialog) closeReceivedInvitationsDialog();
});
receivedInvitationsDialog.addEventListener("close", () => {
  receivedInvitations = [];
  receivedInvitationsList.replaceChildren();
  setShareMessage(receivedInvitationsStatus, "");
});

boardSelector.addEventListener("change", () => {
  const selectedBoard = boards.find((board) => board.id === boardSelector.value);
  if (selectedBoard && selectedBoard.id !== currentBoard?.id) {
    void openBoard(selectedBoard);
  }
});

boardForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!boardForm.reportValidity()) return;

  const name = document.querySelector("#board-name").value.trim();
  if (!name) {
    boardFormMessage.textContent = "Informe um nome para o quadro.";
    return;
  }

  boardSubmitButton.disabled = true;
  setBoardControlsEnabled(false);
  boardFormMessage.textContent = "";
  try {
    await createBoard(db, currentUser.uid, name, boardForm.dataset.newBoardId);
    boards = await loadAccessibleBoards(db, currentUser.uid);
    const newBoard = boards.find((board) => board.id === boardForm.dataset.newBoardId);
    if (!newBoard) throw new Error("O quadro criado não apareceu na lista do usuário.");

    delete boardForm.dataset.newBoardId;
    renderBoardSelector();
    closeBoardDialog();
    await openBoard(newBoard);
  } catch (error) {
    console.error("Erro ao criar o quadro:", error);
    boardFormMessage.textContent = error.code === "permission-denied"
      ? "O Firestore negou a criação do quadro. Verifique as regras publicadas."
      : "Não foi possível criar o quadro. Tente novamente.";
    setBoardControlsEnabled(Boolean(currentBoard));
  } finally {
    boardSubmitButton.disabled = false;
  }
});

// Obtém os elementos do cabeçalho que identificam o usuário autenticado.
const userNameElement = document.getElementById("userName");
const userAvatarElement = document.getElementById("userAvatar");

// Obtém os controles do formulário de edição de conta.
const accountDialog = document.getElementById("account-dialog");
const accountForm = document.getElementById("account-form");
const accountMessage = document.getElementById("account-message");

// Converte erros comuns de atualização de conta em mensagens compreensíveis.
function accountErrorMessage(error) {
  const messages = {
    "auth/requires-recent-login": "Por segurança, saia e entre novamente antes de alterar essa informação.",
    "auth/email-already-in-use": "Este e-mail já está sendo usado por outra conta.",
    "auth/invalid-email": "Informe um endereço de e-mail válido.",
    "auth/invalid-credential": "A senha atual está incorreta.",
    "auth/wrong-password": "A senha atual está incorreta.",
    "auth/weak-password": "A nova senha deve conter pelo menos 6 caracteres."
  };
  return messages[error.code] || getAuthErrorMessage(error);
}

// Fecha e limpa a janela de edição da conta.
function closeAccountDialog() {
  accountDialog.close();
  accountForm.reset();
  accountMessage.textContent = "";
}

// Preenche os dados atuais ao abrir a edição de conta.
document.getElementById("edit-account-button").addEventListener("click", () => {
  if (!currentUser) return;
  document.getElementById("account-name").value = currentUser.displayName || "";
  document.getElementById("account-email").value = currentUser.email || "";
  document.getElementById("account-current-password").value = "";
  document.getElementById("account-password").value = "";
  accountMessage.textContent = "";
  accountDialog.showModal();
  document.getElementById("account-name").focus();
});

// Conecta os botões de fechar e cancelar à rotina de encerramento.
document.getElementById("close-account-dialog").addEventListener("click", closeAccountDialog);
document.getElementById("cancel-account-edit").addEventListener("click", closeAccountDialog);

// Permite fechar a janela de conta ao clicar no fundo do modal.
accountDialog.addEventListener("click", (event) => {
  if (event.target === accountDialog) closeAccountDialog();
});

// Valida e salva as alterações de nome, e-mail e senha da conta.
accountForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!accountForm.reportValidity()) return;

  // Lê os dados digitados e normaliza o e-mail.
  const name = document.getElementById("account-name").value.trim();
  const email = document.getElementById("account-email").value.trim().toLowerCase();
  const currentPassword = document.getElementById("account-current-password").value;
  const password = document.getElementById("account-password").value;

  // Exige nome e e-mail válidos para atualizar a conta.
  if (!name || !email) {
    accountMessage.textContent = "Informe seu nome e e-mail.";
    return;
  }

  // Valida o tamanho da senha somente quando uma nova senha foi informada.
  if (password && password.length < 6) {
    accountMessage.textContent = "A nova senha deve ter pelo menos 6 caracteres.";
    return;
  }

  if (password && !currentPassword) {
    accountMessage.textContent = "Informe sua senha atual para definir uma nova senha.";
    document.getElementById("account-current-password").focus();
    return;
  }

  const submitButton = accountForm.querySelector('[type="submit"]');
  submitButton.disabled = true;
  try {
    if (password) {
      const credential = EmailAuthProvider.credential(currentUser.email, currentPassword);
      await reauthenticateWithCredential(currentUser, credential);
      await updatePassword(currentUser, password);
    }

    // Mantém o nome público da conta sincronizado com Firebase Authentication.
    await updateProfile(currentUser, { displayName: name });

    // Persiste o nome de exibição no documento privado do usuário.
    await setDoc(doc(db, "users", currentUser.uid), { name }, { merge: true });

    // Firebase envia uma mensagem para confirmar a alteração de e-mail.
    const emailChanged = email.toLowerCase() !== (currentUser.email || "").toLowerCase();
    if (emailChanged) await verifyBeforeUpdateEmail(currentUser, email);
  } catch (error) {
    console.error("Erro ao atualizar dados da conta no Firebase:", error);
    accountMessage.textContent = accountErrorMessage(error);
    submitButton.disabled = false;
    return;
  }

  // Atualiza nome e avatar no cabeçalho com os dados do usuário atual.
  userNameElement.textContent = name;
  userAvatarElement.textContent = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
  const emailChanged = email.toLowerCase() !== (currentUser.email || "").toLowerCase();
  announcement.textContent = emailChanged
    ? "Nome atualizado. Confirme o novo e-mail pelo link enviado para concluir a alteração."
    : "As informações da conta foram atualizadas.";
  closeAccountDialog();
});

// Encerra a sessão no Firebase ao sair da conta.
document.getElementById("logout-button").addEventListener("click", async () => {
  try {
    await signOut(auth);
    window.location.replace("login.html");
  } catch (error) {
    console.error("Erro ao encerrar sessão no Firebase:", error);
    announcement.textContent = "Não foi possível sair da conta. Tente novamente.";
  }
});

setBoardControlsEnabled(false);
setTaskActionsEnabled(false);

// Espera o Firebase restaurar a sessão antes de carregar os dados privados.
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    currentUser = null;
    currentBoard = null;
    syncShareButton();
    syncReceivedInvitationsButton();
    if (shareDialog.open) closeShareDialog();
    if (receivedInvitationsDialog.open) closeReceivedInvitationsDialog();
    receivedInvitations = [];
    boards = [];
    tasks = [];
    columns = [];
    boardElement.replaceChildren();
    activeBoardName.textContent = "";
    activeBoardRole.textContent = "";
    delete activeBoardRole.dataset.role;
    setBoardControlsEnabled(false);
    setTaskActionsEnabled(false);
    boardStatus.textContent = "Sessão não encontrada. Redirecionando para o login...";
    window.location.replace("login.html");
    return;
  }

  currentUser = user;
  syncReceivedInvitationsButton();
  boardStatus.textContent = "Conectado. Preparando seus quadros...";
  boardStatus.classList.remove("is-error");
  setBoardControlsEnabled(false);
  setTaskActionsEnabled(false);
  const displayName = user.displayName || user.email || "Usuário";
  userNameElement.textContent = displayName;
  userAvatarElement.textContent = displayName
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");

  try {
    await ensureInitialBoardAndMigrate(db, user.uid);
    if (currentUser.uid !== user.uid) return;

    boards = await loadAccessibleBoards(db, user.uid);
    if (boards.length === 0) {
      throw new Error("Nenhum quadro acessível foi encontrado após a migração.");
    }

    renderBoardSelector();
    const preferredBoard = getPreferredBoard(boards, user.uid);
    if (!preferredBoard) throw new Error("Não foi possível selecionar um quadro.");
    await openBoard(preferredBoard);
  } catch (error) {
    console.error("Erro ao preparar os quadros do usuário:", error);
    const message = error.code === "permission-denied"
      ? "O Firestore negou o acesso. Publique as regras atualizadas do arquivo firestore.rules."
      : error.code === "unavailable"
        ? "O Firebase está indisponível. Verifique sua conexão com a internet."
        : error.message || "Não foi possível preparar seus quadros. Confira a conexão e as regras do Firebase.";
    boardStatus.textContent = message;
    boardStatus.classList.add("is-error");
    announcement.textContent = message;
  }
});
