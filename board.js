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
  deleteField,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  createBoard,
  createBoardInvitation,
  deleteOwnedBoard,
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

function getTaskRouteFromLocation() {
  const pathMatch = window.location.pathname.match(/(?:^|\/)tasks\/([^/]+)\/?$/);
  const query = new URLSearchParams(window.location.search);
  const queryTaskId = query.get("taskId");
  if (!pathMatch && !queryTaskId) return null;

  let taskId = "";
  try {
    taskId = pathMatch ? decodeURIComponent(pathMatch[1]) : queryTaskId;
  } catch (error) {
    console.error("A URL da tarefa contém um identificador inválido:", error);
  }

  return {
    taskId,
    boardId: query.get("boardId") || ""
  };
}

const taskRoute = getTaskRouteFromLocation();
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
const deleteBoardButton = document.querySelector("#delete-board-button");
const editAccountButton = document.querySelector("#edit-account-button");
// Referências aos formulários, caixas de diálogo e avisos acessíveis do quadro.
const dialog = document.querySelector("#task-dialog");
const taskForm = document.querySelector("#task-form");
const announcement = document.querySelector("#board-announcement");
const boardStatus = document.querySelector("#board-status");
const taskDetail = document.querySelector("#task-detail");
const taskDetailStatus = document.querySelector("#task-detail-status");
const taskDetailCard = document.querySelector("#task-detail-card");
const taskDetailBoard = document.querySelector("#task-detail-board");
const taskDetailTitle = document.querySelector("#task-detail-title");
const taskDetailDescription = document.querySelector("#task-detail-description");
const taskDetailColumn = document.querySelector("#task-detail-column");
const taskDetailRole = document.querySelector("#task-detail-role");
const taskDetailBack = document.querySelector("#task-detail-back");
const taskDetailEditButton = document.querySelector("#task-detail-edit");
const taskAssigneeSelect = document.querySelector("#task-assignee");
const taskAssigneeStatus = document.querySelector("#task-assignee-status");
const taskPrioritySelect = document.querySelector("#task-priority");
const taskDetailLabelList = document.querySelector("#task-detail-label-list");
const taskLabelForm = document.querySelector("#task-label-form");
const taskLabelName = document.querySelector("#task-label-name");
const taskLabelColor = document.querySelector("#task-label-color");
const taskLabelAddButton = document.querySelector("#task-label-add");
const taskMetadataStatus = document.querySelector("#task-metadata-status");
const taskComments = document.querySelector("#task-comments");
const taskCommentsStatus = document.querySelector("#task-comments-status");
const taskCommentList = document.querySelector("#task-comment-list");
const taskCommentForm = document.querySelector("#task-comment-form");
const taskCommentText = document.querySelector("#task-comment-text");
const taskCommentSubmit = document.querySelector("#task-comment-submit");
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
let taskDetailColumnName = "";
let stopTasksListener = null;
let stopColumnsListener = null;
let stopCommentsListener = null;
let stopBoardMembersListener = null;
let boardMembers = [];
let isSavingTaskMetadata = false;
const taskPriorities = ["low", "medium", "high", "urgent"];
const taskPriorityLabels = {
  low: "Baixa",
  medium: "Média",
  high: "Alta",
  urgent: "Urgente"
};

if (taskRoute) {
  document.body.classList.add("task-detail-page");
  taskDetail.hidden = false;
  taskDetailBack.href = new URL("board.html", document.baseURI).href;
  taskDetailBack.textContent = "Voltar à lista de quadros";
}

// Constrói a coleção de tarefas dentro do quadro ativo.
function tasksCollection(boardId = currentBoard.id) {
  return collection(db, "boards", boardId, "tasks");
}

function canEditTasks() {
  return currentBoard?.role === "owner" || currentBoard?.role === "editor";
}

function getReadOnlyRoleMessage() {
  return "Seu perfil atual é Leitor e não permite criar, editar, mover ou excluir tarefas. Solicite ao proprietário a alteração do seu perfil para Editor e aguarde a aprovação.";
}

function canManageMembers() {
  return Boolean(currentUser &&
    currentBoard?.role === "owner" &&
    currentBoard.ownerUid === currentUser.uid);
}

function canDeleteCurrentBoard() {
  return Boolean(currentUser &&
    currentBoard?.role === "owner" &&
    currentBoard.ownerUid === currentUser.uid);
}

function canManageWipLimits() {
  return Boolean(currentUser &&
    currentBoard?.role === "owner" &&
    currentBoard.ownerUid === currentUser.uid);
}

function syncWipControls(enabled = boardReady) {
  columns.forEach((column) => {
    const isSaving = column.dataset.wipSaving === "true";
    const input = column.querySelector(".column-wip-limit-input");
    const saveButton = column.querySelector(".column-wip-save");
    const removeButton = column.querySelector(".column-wip-remove");
    if (input) input.disabled = !enabled || !canManageWipLimits() || isSaving;
    if (saveButton) saveButton.disabled = !enabled || !canManageWipLimits() || isSaving;
    if (removeButton) {
      removeButton.disabled = !enabled ||
        !canManageWipLimits() ||
        isSaving ||
        getColumnWipLimit(column) === null;
    }
  });
}

function getColumnWipLimit(column) {
  const value = column?.dataset.wipLimit;
  return value === undefined ? null : Number(value);
}

function getColumnTaskCount(columnId) {
  return tasks.filter((task) => task.columnId === columnId).length;
}

function isWipLimitReached(columnId, excludingTaskId = null) {
  const column = columns.find((item) => item.dataset.columnId === columnId);
  const limit = getColumnWipLimit(column);
  if (limit === null) return false;
  const count = tasks.filter((task) =>
    task.columnId === columnId && task.id !== excludingTaskId
  ).length;
  return count >= limit;
}

function clearWipWarning() {
  if (boardStatus.classList.contains("is-warning") &&
      /limite wip/i.test(boardStatus.textContent)) {
    boardStatus.textContent = "";
    boardStatus.classList.remove("is-warning");
  }
}

function syncShareButton() {
  shareBoardButton.hidden = !canManageMembers();
  deleteBoardButton.hidden = !canDeleteCurrentBoard();
}

function syncReceivedInvitationsButton() {
  receivedInvitationsButton.hidden = !currentUser;
}

async function getInvitationUser() {
  const user = auth.currentUser;
  if (!user || !user.uid) {
    throw new Error("Entre na sua conta para acessar os convites.");
  }

  await reload(user);
  if (auth.currentUser?.uid !== user.uid) {
    throw new Error("A sessão mudou. Entre novamente para acessar os convites.");
  }
  if (!user.email) {
    throw new Error("A conta autenticada não possui um endereço de e-mail.");
  }

  await user.getIdToken(true);
  return user;
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

function normalizeTask(task) {
  const labels = Array.isArray(task.labels)
    ? task.labels.filter((label) =>
      label &&
      typeof label.name === "string" &&
      label.name.trim() &&
      label.name.trim().length <= 24 &&
      typeof label.color === "string" &&
      /^#[\da-f]{6}$/i.test(label.color)
    ).slice(0, 20)
    : [];
  const seenLabels = new Set();
  return {
    ...task,
    description: typeof task.description === "string" ? task.description : "",
    assigneeUid: typeof task.assigneeUid === "string" ? task.assigneeUid : "",
    priority: taskPriorities.includes(task.priority) ? task.priority : "",
    labels: labels.filter((label) => {
      const key = label.name.trim().toLocaleLowerCase();
      if (seenLabels.has(key)) return false;
      seenLabels.add(key);
      return true;
    }).map((label) => ({
      name: label.name.trim(),
      color: label.color.toUpperCase()
    }))
  };
}

function getMemberDisplayName(member) {
  if (member.isOwner) {
    if (currentUser?.uid === member.uid) {
      return currentUser.displayName?.trim() ||
        member.name?.trim() ||
        "Proprietário do quadro";
    }
    return member.name?.trim() || "Proprietário do quadro";
  }
  return member.name?.trim() || "Nome não informado";
}

function getAssigneeName(assigneeUid) {
  if (!assigneeUid) return "";
  const member = boardMembers.find((item) => item.uid === assigneeUid);
  return member ? getMemberDisplayName(member) : "";
}

function startBoardMembersListener(boardId, ownerUid) {
  stopBoardMembersListener?.();
  stopBoardMembersListener = null;
  boardMembers = [{ uid: ownerUid, role: "owner", isOwner: true }];

  return new Promise((resolve, reject) => {
    let waitingForFirstSnapshot = true;
    const unsubscribe = onSnapshot(
      collection(db, "boards", boardId, "members"),
      (snapshot) => {
        if (currentBoard?.id !== boardId) return;
        let members;
        try {
          members = snapshot.docs.map((memberDocument) => {
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
              isOwner: false
            };
          });
        } catch (error) {
          console.error("Dados inválidos ao carregar os membros do quadro:", error);
          boardMembers = [{ uid: ownerUid, role: "owner", isOwner: true }];
          if (waitingForFirstSnapshot) {
            waitingForFirstSnapshot = false;
            unsubscribe();
            stopBoardMembersListener = null;
            reject(error);
          } else {
            renderBoard();
            const currentTask = tasks.find((task) => task.id === taskRoute?.taskId);
            if (taskRoute && currentTask) {
              renderTaskDetail(currentTask, taskDetailColumnName);
            }
          }
          return;
        }

        boardMembers = [
          { uid: ownerUid, role: "owner", isOwner: true },
          ...members
        ];
        if (currentBoard?.id === boardId && currentUser) {
          if (currentUser.uid === ownerUid) {
            currentBoard.role = "owner";
          } else {
            const currentMembership = boardMembers.find(
              (member) => member.uid === currentUser.uid
            );
            if (currentMembership) currentBoard.role = currentMembership.role;
          }
          renderBoard();
          const currentTask = tasks.find((task) => task.id === taskRoute?.taskId);
          if (taskRoute && currentTask) {
            renderTaskDetail(currentTask, taskDetailColumnName);
          }
        }

        if (waitingForFirstSnapshot) {
          waitingForFirstSnapshot = false;
          resolve();
        }
      },
      (error) => {
        if (currentBoard?.id !== boardId) return;
        console.error("Erro ao carregar as pessoas com acesso ao quadro:", error);
        boardMembers = currentBoard?.id === boardId
          ? [{ uid: ownerUid, role: "owner", isOwner: true }]
          : [];
        if (waitingForFirstSnapshot) {
          waitingForFirstSnapshot = false;
          stopBoardMembersListener = null;
          reject(error);
        } else {
          renderBoard();
          const currentTask = tasks.find((task) => task.id === taskRoute?.taskId);
          if (taskRoute && currentTask) {
            renderTaskDetail(currentTask, taskDetailColumnName);
          }
          const status = taskRoute ? taskDetailStatus : boardStatus;
          status.textContent = "Não foi possível atualizar as pessoas com acesso ao quadro.";
          status.classList.add("is-error");
        }
      }
    );
    stopBoardMembersListener = unsubscribe;
  });
}

// Mantém em memória os documentos carregados para o usuário autenticado.
let tasks = [];

// Busca os documentos da coleção do quadro ativo.
function loadTasks() {
  stopTasksListener?.();
  return new Promise((resolve, reject) => {
    let waitingForFirstSnapshot = true;
    const unsubscribe = onSnapshot(tasksCollection(), (snapshot) => {
      const loadedTasks = snapshot.docs.map((taskDocument) => ({
        ...taskDocument.data(),
        id: taskDocument.id
      }));
      if (!loadedTasks.every(isValidTask)) {
        const error = new Error("O Firestore contém dados de tarefa em formato inválido.");
        if (waitingForFirstSnapshot) {
          waitingForFirstSnapshot = false;
          unsubscribe();
          stopTasksListener = null;
          reject(error);
        } else {
          reportFirestoreError("carregar", error);
        }
        return;
      }

      tasks = loadedTasks.map(normalizeTask);
      renderBoard();
      if (waitingForFirstSnapshot) {
        waitingForFirstSnapshot = false;
        resolve();
      }
    }, (error) => {
      if (waitingForFirstSnapshot) {
        waitingForFirstSnapshot = false;
        stopTasksListener = null;
        reject(error);
      } else {
        reportFirestoreError("carregar", error);
      }
    });
    stopTasksListener = unsubscribe;
  });
}

function taskDetailUrl(boardId, taskId) {
  const url = new URL("board.html", document.baseURI);
  url.searchParams.set("taskId", taskId);
  url.searchParams.set("boardId", boardId);
  return url.href;
}

function createTaskLabel(label, removable = false, onRemove = null) {
  const item = document.createElement("li");
  item.className = "task-label";
  item.style.setProperty("--task-label-color", label.color);
  const name = document.createElement("span");
  name.textContent = label.name;
  item.append(name);

  if (removable && onRemove) {
    const removeButton = document.createElement("button");
    removeButton.className = "task-label-remove";
    removeButton.type = "button";
    removeButton.textContent = "×";
    removeButton.setAttribute("aria-label", `Remover etiqueta ${label.name}`);
    removeButton.disabled = isSavingTaskMetadata;
    removeButton.addEventListener("click", onRemove);
    item.append(removeButton);
  }
  return item;
}

function renderTaskMetadata(task) {
  const canEdit = canEditTasks();
  taskAssigneeSelect.replaceChildren();
  const unassignedOption = document.createElement("option");
  unassignedOption.value = "";
  unassignedOption.textContent = "Sem responsável";
  taskAssigneeSelect.append(unassignedOption);

  boardMembers.forEach((member) => {
    const option = document.createElement("option");
    option.value = member.uid;
    option.textContent = getMemberDisplayName(member);
    taskAssigneeSelect.append(option);
  });

  const assigneeIsAvailable = boardMembers.some(
    (member) => member.uid === task.assigneeUid
  );
  if (task.assigneeUid && !assigneeIsAvailable) {
    const unavailableOption = document.createElement("option");
    unavailableOption.value = "__unavailable_assignee__";
    unavailableOption.textContent = "Responsável anterior sem acesso";
    unavailableOption.disabled = true;
    taskAssigneeSelect.append(unavailableOption);
  }
  taskAssigneeSelect.value = task.assigneeUid
    ? (assigneeIsAvailable ? task.assigneeUid : "__unavailable_assignee__")
    : "";
  taskAssigneeSelect.disabled = !canEdit || isSavingTaskMetadata;
  taskAssigneeStatus.hidden = !task.assigneeUid || assigneeIsAvailable;
  taskAssigneeStatus.textContent = task.assigneeUid && !assigneeIsAvailable
    ? "O responsável anterior não tem mais acesso a este quadro. Selecione outra pessoa ou remova a atribuição."
    : "";

  taskPrioritySelect.value = task.priority;
  taskPrioritySelect.disabled = !canEdit || isSavingTaskMetadata;
  taskLabelForm.hidden = !canEdit;
  taskLabelName.disabled = !canEdit || isSavingTaskMetadata;
  taskLabelColor.disabled = !canEdit || isSavingTaskMetadata;
  taskLabelAddButton.disabled = !canEdit || isSavingTaskMetadata ||
    task.labels.length >= 20;

  taskDetailLabelList.replaceChildren();
  task.labels.forEach((label, index) => {
    taskDetailLabelList.append(createTaskLabel(label, canEdit, () => {
      const updatedLabels = task.labels.filter((_, labelIndex) => labelIndex !== index);
      void saveTaskMetadata(task, { labels: updatedLabels }, "Etiqueta removida.");
    }));
  });

}

function renderTaskDetail(task, columnName) {
  taskDetailColumnName = columnName;
  taskDetailBoard.textContent = currentBoard.name;
  taskDetailTitle.textContent = task.title;
  taskDetailDescription.textContent = task.description || "Sem descrição.";
  taskDetailColumn.textContent = `Lista: ${columnName}`;
  taskDetailRole.textContent = getRoleLabel(currentBoard.role);
  taskDetailRole.dataset.role = currentBoard.role;
  taskDetailEditButton.hidden = !canEditTasks();
  taskDetailBack.href = new URL("board.html", document.baseURI).href;
  renderTaskMetadata(task);
  taskDetailCard.hidden = false;
  taskComments.hidden = false;
  taskCommentForm.hidden = !canEditTasks();
  taskDetailStatus.textContent = "";
  taskDetailStatus.classList.remove("is-error");
}

async function saveTaskMetadata(task, changes, successMessage) {
  if (!canEditTasks() || isSavingTaskMetadata || !currentBoard) return false;
  const currentTask = tasks.find((item) => item.id === task.id);
  if (!currentTask) return false;

  isSavingTaskMetadata = true;
  taskMetadataStatus.textContent = "Salvando alterações...";
  taskMetadataStatus.classList.remove("is-error", "is-success");
  renderTaskMetadata(currentTask);

  try {
    await updateDoc(doc(db, "boards", currentBoard.id, "tasks", currentTask.id), {
      ...changes,
      updatedAt: serverTimestamp()
    });
    Object.assign(currentTask, normalizeTask({ ...currentTask, ...changes }));
    renderBoard();
    renderTaskMetadata(currentTask);
    taskMetadataStatus.textContent = successMessage;
    taskMetadataStatus.classList.add("is-success");
    return true;
  } catch (error) {
    console.error("Erro ao atualizar os detalhes da tarefa:", error);
    taskMetadataStatus.textContent = error.code === "permission-denied"
      ? "O Firestore não permitiu atualizar os detalhes. Verifique as regras para os campos de responsável, prioridade e etiquetas."
      : "Não foi possível salvar as alterações. Verifique sua conexão e tente novamente.";
    taskMetadataStatus.classList.add("is-error");
    renderTaskMetadata(currentTask);
    return false;
  } finally {
    isSavingTaskMetadata = false;
    renderTaskMetadata(currentTask);
  }
}

function taskCommentsCollection() {
  return collection(
    db,
    "boards",
    currentBoard.id,
    "tasks",
    taskRoute.taskId,
    "comments"
  );
}

function commentTimestampMillis(timestamp) {
  return timestamp && typeof timestamp.toMillis === "function"
    ? timestamp.toMillis()
    : Number.MAX_SAFE_INTEGER;
}

function formatCommentDate(timestamp) {
  if (!timestamp || typeof timestamp.toDate !== "function") return "Publicando...";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(timestamp.toDate());
}

function renderTaskComments(snapshot) {
  const comments = snapshot.docs
    .map((commentDocument) => ({
      ...commentDocument.data(),
      id: commentDocument.id
    }))
    .sort((left, right) =>
      commentTimestampMillis(left.createdAt) - commentTimestampMillis(right.createdAt) ||
      left.id.localeCompare(right.id)
    );

  taskCommentList.replaceChildren();
  comments.forEach((comment) => {
    if (typeof comment.text !== "string") return;
    const item = document.createElement("li");
    item.className = "task-comment";

    const header = document.createElement("div");
    header.className = "task-comment-header";
    const author = document.createElement("strong");
    author.textContent = typeof comment.authorName === "string" && comment.authorName.trim()
      ? comment.authorName.trim()
      : "Usuário";
    const date = document.createElement("time");
    date.dateTime = comment.createdAt && typeof comment.createdAt.toDate === "function"
      ? comment.createdAt.toDate().toISOString()
      : "";
    date.textContent = formatCommentDate(comment.createdAt);
    header.append(author, date);

    const text = document.createElement("p");
    text.textContent = comment.text;
    item.append(header, text);
    taskCommentList.append(item);
  });

  taskCommentsStatus.textContent = comments.length
    ? ""
    : "Ainda não há comentários nesta tarefa.";
  taskCommentsStatus.classList.remove("is-error");
}

function listenToTaskComments() {
  stopCommentsListener?.();
  taskCommentList.replaceChildren();
  taskCommentsStatus.textContent = "Carregando comentários...";
  taskCommentsStatus.classList.remove("is-error");
  taskComments.hidden = false;
  taskCommentForm.hidden = !canEditTasks();

  stopCommentsListener = onSnapshot(taskCommentsCollection(), renderTaskComments, (error) => {
    console.error("Erro ao carregar comentários da tarefa:", error);
    if (error.code === "permission-denied") {
      taskCommentList.replaceChildren();
    }
    taskCommentsStatus.textContent = error.code === "permission-denied"
      ? "Você não tem permissão para visualizar os comentários desta tarefa."
      : "Não foi possível carregar os comentários. Verifique sua conexão e tente novamente.";
    taskCommentsStatus.classList.add("is-error");
  });
}

function setTaskDetailStatus(message, isError = false) {
  taskDetailStatus.textContent = message;
  taskDetailStatus.classList.toggle("is-error", isError);
  taskDetailCard.hidden = true;
  taskComments.hidden = true;
}

function denyTaskDetailAccess() {
  stopCommentsListener?.();
  stopCommentsListener = null;
  stopBoardMembersListener?.();
  stopBoardMembersListener = null;
  currentBoard = null;
  tasks = [];
  columns = [];
  boardMembers = [];
  taskDetailColumnName = "";
  taskDetailBoard.textContent = "";
  taskDetailTitle.textContent = "";
  taskDetailDescription.textContent = "";
  taskDetailColumn.textContent = "";
  taskDetailRole.textContent = "";
  taskDetailEditButton.hidden = true;
  taskCommentList.replaceChildren();
  taskComments.hidden = true;
  setTaskActionsEnabled(false);
  setTaskDetailStatus("Você não tem permissão para acessar esta tarefa.", true);
}

async function openTaskDetail(user) {
  if (!taskRoute?.taskId || !taskRoute.boardId) {
    setTaskDetailStatus("O link da tarefa está incompleto ou inválido.", true);
    return;
  }

  try {
    const boardSnapshot = await getDoc(doc(db, "boards", taskRoute.boardId));
    if (!boardSnapshot.exists()) {
      denyTaskDetailAccess();
      return;
    }

    const boardData = boardSnapshot.data();
    let role = "owner";
    if (boardData.ownerUid !== user.uid) {
      const memberSnapshot = await getDoc(
        doc(db, "boards", taskRoute.boardId, "members", user.uid)
      );
      if (!memberSnapshot.exists() ||
          memberSnapshot.data().uid !== user.uid ||
          !["editor", "reader"].includes(memberSnapshot.data().role)) {
        denyTaskDetailAccess();
        return;
      }
      role = memberSnapshot.data().role;
    }

    currentBoard = {
      ...boardData,
      id: taskRoute.boardId,
      role
    };
    const taskSnapshot = await getDoc(
      doc(db, "boards", taskRoute.boardId, "tasks", taskRoute.taskId)
    );
    if (!taskSnapshot.exists()) {
      setTaskDetailStatus("Esta tarefa não existe mais neste quadro.", true);
      return;
    }

    const boardColumns = await loadBoardColumns(db, taskRoute.boardId);
    const task = normalizeTask({
      ...taskSnapshot.data(),
      id: taskSnapshot.id
    });
    const column = boardColumns.find((item) => item.id === task.columnId);
    if (typeof task.title !== "string" || !column) {
      setTaskDetailStatus("Os dados desta tarefa ou da lista associada são inválidos.", true);
      return;
    }

    tasks = [task];
    setTaskActionsEnabled(true);
    try {
      await startBoardMembersListener(taskRoute.boardId, boardData.ownerUid);
    } catch (error) {
      taskMetadataStatus.textContent = "Não foi possível carregar as pessoas com acesso. A atribuição de responsáveis ficará indisponível.";
      taskMetadataStatus.classList.add("is-error");
    }
    renderTaskDetail(task, column.name);
    listenToTaskComments();
  } catch (error) {
    console.error("Erro ao carregar a tarefa compartilhada:", error);
    if (error.code === "permission-denied") {
      denyTaskDetailAccess();
      return;
    }
    setTaskDetailStatus(
      "Não foi possível carregar a tarefa. Verifique sua conexão e tente novamente.",
      true
    );
  }
}

function setTaskActionsEnabled(enabled) {
  boardReady = enabled;
  const canEdit = enabled && canEditTasks();
  document.querySelectorAll(".column-add-task").forEach((button) => {
    button.disabled = !canEdit;
  });
  boardElement.classList.toggle("is-read-only", enabled && !canEdit);
  updateTaskCounts();
  syncWipControls(enabled);
}

function setBoardControlsEnabled(enabled) {
  boardSelector.disabled = !enabled;
  createBoardButton.disabled = !enabled;
  editAccountButton.disabled = !enabled;
  deleteBoardButton.disabled = !enabled || !canDeleteCurrentBoard();
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
    const requestedBoardId = new URLSearchParams(window.location.search).get("boardId");
    const requestedBoard = availableBoards.find((board) => board.id === requestedBoardId);
    if (requestedBoard) return requestedBoard;

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
  const ownedBoards = boards.filter((board) => board.role === "owner");
  const collaboratedBoards = boards.filter((board) => board.role !== "owner");

  [
    { label: "Meus projetos", projects: ownedBoards },
    { label: "Projetos como colaborador", projects: collaboratedBoards }
  ].forEach(({ label, projects }) => {
    if (projects.length === 0) return;

    const group = document.createElement("optgroup");
    group.label = label;
    projects.forEach((board) => {
      const option = document.createElement("option");
      option.value = board.id;
      option.textContent = board.name;
      group.append(option);
    });
    boardSelector.append(group);
  });

  boardSelector.disabled = boards.length === 0;
  if (currentBoard) boardSelector.value = currentBoard.id;
}

async function openBoard(board, rememberSelection = true) {
  stopTasksListener?.();
  stopTasksListener = null;
  stopColumnsListener?.();
  stopColumnsListener = null;
  stopBoardMembersListener?.();
  stopBoardMembersListener = null;
  const previousBoardId = currentBoard?.id;
  currentBoard = board;
  boardMembers = [{ uid: board.ownerUid, role: "owner", isOwner: true }];
  taskMetadataStatus.textContent = "";
  taskMetadataStatus.classList.remove("is-error", "is-success");
  if (shareDialog.open && previousBoardId !== board.id) closeShareDialog();
  syncShareButton();
  activeBoardName.textContent = board.name;
  activeBoardRole.textContent = getRoleLabel(board.role);
  activeBoardRole.dataset.role = board.role;
  boardSelector.value = board.id;
  setBoardControlsEnabled(false);
  setTaskActionsEnabled(false);
  boardStatus.classList.remove("is-error");
  boardStatus.classList.remove("is-warning");
  boardStatus.textContent = "Carregando o quadro...";

  const selectionSaved = !rememberSelection || saveSelectedBoard(board.id);

  try {
    const boardColumns = await loadBoardColumns(db, board.id);
    if (boardColumns.length === 0) {
      throw new Error("O quadro não possui colunas configuradas.");
    }

    renderColumns(boardColumns);
    startColumnWipListener(board.id);
    tasks = [];
    renderBoard();
    try {
      await startBoardMembersListener(board.id, board.ownerUid);
    } catch (error) {
      taskMetadataStatus.textContent = "Não foi possível carregar as pessoas com acesso. A atribuição de responsáveis ficará indisponível.";
      taskMetadataStatus.classList.add("is-error");
    }
    await loadTasks();
    boardStatus.textContent = selectionSaved
      ? (board.role === "reader" ? getReadOnlyRoleMessage() : "")
      : `O quadro foi aberto, mas não será lembrado neste navegador.${board.role === "reader"
        ? ` ${getReadOnlyRoleMessage()}`
        : ""}`;
    boardStatus.classList.toggle("is-error", !selectionSaved);
    boardStatus.classList.toggle("is-warning", selectionSaved && board.role === "reader");
    setTaskActionsEnabled(true);
  } catch (error) {
    console.error("Erro ao carregar o quadro selecionado:", error);
    boardStatus.textContent = error.code === "permission-denied"
      ? "Você não tem permissão para acessar este quadro."
      : error.message || "Não foi possível carregar o quadro. Verifique a conexão.";
    boardStatus.classList.add("is-error");
    boardStatus.classList.remove("is-warning");
    announcement.textContent = boardStatus.textContent;
  }

  setBoardControlsEnabled(true);
  renderBoardSelector();
}

// Mostra falhas de persistência no quadro e no console.
function reportFirestoreError(action, error) {
  console.error(`Erro ao ${action} no Firestore:`, error);
  const reason = error.code === "permission-denied"
    ? "Seu perfil atual não permite esta alteração. Solicite ao proprietário a mudança do seu perfil e aguarde a aprovação."
    : error.code === "unavailable"
      ? "O Firebase está indisponível. Verifique sua conexão com a internet."
      : error.code === "not-found"
        ? "O banco Firestore ainda não foi criado neste projeto."
        : "Confira a conexão e as configurações do Firebase.";
  if (error.code === "permission-denied" && action === "mover") {
    const title = "Movimentação não permitida";
    const details = "Seu perfil atual não permite mover tarefas. Peça ao proprietário para alterar seu perfil para Editor e aguarde a aprovação.";
    const message = `${title}. ${details}`;
    announcement.textContent = message;
    const titleElement = document.createElement("strong");
    titleElement.textContent = title;
    const detailsElement = document.createElement("span");
    detailsElement.textContent = details;
    boardStatus.replaceChildren(titleElement, detailsElement);
    boardStatus.classList.remove("is-error");
    boardStatus.classList.add("is-warning");
    return;
  }

  const message = `Não foi possível ${action} a tarefa. ${reason}`;
  announcement.textContent = message;
  if (taskRoute) {
    taskDetailStatus.textContent = message;
    taskDetailStatus.classList.add("is-error");
    return;
  }

  boardStatus.textContent = message;
  boardStatus.classList.add("is-error");
  boardStatus.classList.remove("is-warning");
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

  const metadata = document.createElement("div");
  metadata.className = "task-card-metadata";
  if (task.assigneeUid) {
    const assignee = document.createElement("span");
    assignee.className = "task-assignee-badge";
    const assigneeName = getAssigneeName(task.assigneeUid);
    assignee.textContent = assigneeName
      ? `Responsável: ${assigneeName}`
      : "Responsável sem acesso";
    metadata.append(assignee);
  }
  if (task.priority) {
    const priority = document.createElement("span");
    priority.className = `task-priority-badge priority-${task.priority}`;
    priority.textContent = taskPriorityLabels[task.priority];
    metadata.append(priority);
  }
  if (task.labels.length) {
    const labels = document.createElement("ul");
    labels.className = "task-label-list task-card-labels";
    task.labels.forEach((label) => labels.append(createTaskLabel(label)));
    metadata.append(labels);
  }
  if (metadata.childElementCount) card.append(metadata);

  const openLink = document.createElement("a");
  openLink.className = "task-open-link";
  openLink.href = taskDetailUrl(currentBoard.id, task.id);
  openLink.target = "_blank";
  openLink.rel = "noopener noreferrer";
  openLink.textContent = "Abrir tarefa";
  card.append(openLink);

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
    if (!canEditTasks() || event.target.closest("button, a")) {
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

function updateColumnWipState(column, wipLimit) {
  if (Number.isSafeInteger(wipLimit) && wipLimit >= 0) {
    column.dataset.wipLimit = String(wipLimit);
  } else {
    delete column.dataset.wipLimit;
  }

  const limitInput = column.querySelector(".column-wip-limit-input");
  if (limitInput && document.activeElement !== limitInput) {
    limitInput.value = getColumnWipLimit(column) ?? "";
  }
  const removeButton = column.querySelector(".column-wip-remove");
  if (removeButton) removeButton.disabled = getColumnWipLimit(column) === null;
  updateTaskCounts();
  syncWipControls();
}

async function saveColumnWipLimit(column, value) {
  if (!canManageWipLimits() || !boardReady) return;
  const input = column.querySelector(".column-wip-limit-input");
  const saveButton = column.querySelector(".column-wip-save");
  const removeButton = column.querySelector(".column-wip-remove");
  const limit = value === null ? null : Number(value);
  if (limit !== null &&
      (value === "" || !Number.isSafeInteger(limit) || limit < 0)) {
    boardStatus.textContent = "Informe um limite inteiro igual ou maior que zero.";
    boardStatus.classList.add("is-error");
    return;
  }

  column.dataset.wipSaving = "true";
  saveButton.disabled = true;
  removeButton.disabled = true;
  input.disabled = true;
  try {
    await updateDoc(doc(db, "boards", currentBoard.id, "columns", column.dataset.columnId), {
      wipLimit: limit === null ? deleteField() : limit
    });
    updateColumnWipState(column, limit);
    clearWipWarning();
    boardStatus.textContent = limit === null
      ? "Limite WIP removido."
      : `Limite WIP definido para ${column.querySelector("h2").textContent}.`;
    boardStatus.classList.remove("is-error");
  } catch (error) {
    console.error("Erro ao salvar o limite WIP da coluna:", error);
    boardStatus.textContent = error.code === "permission-denied"
      ? "O Firestore não permitiu alterar o limite. Somente o proprietário pode configurar o WIP."
      : "Não foi possível salvar o limite WIP. Verifique a conexão e tente novamente.";
    boardStatus.classList.add("is-error");
  } finally {
    delete column.dataset.wipSaving;
    syncWipControls();
  }
}

function createColumnWipControls(column, boardColumn) {
  const controls = document.createElement("form");
  controls.className = "column-wip-controls";
  controls.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveColumnWipLimit(
      column,
      controls.querySelector(".column-wip-limit-input").value
    );
  });

  const label = document.createElement("label");
  label.className = "sr-only";
  label.textContent = `Limite de tarefas para ${boardColumn.name}`;

  const input = document.createElement("input");
  input.className = "column-wip-limit-input";
  input.type = "number";
  input.min = "0";
  input.step = "1";
  input.inputMode = "numeric";
  input.placeholder = "Sem limite";
  input.value = Number.isSafeInteger(boardColumn.wipLimit) && boardColumn.wipLimit >= 0
    ? String(boardColumn.wipLimit)
    : "";
  input.disabled = !boardReady || !canManageWipLimits();
  label.htmlFor = `wip-limit-${boardColumn.id}`;
  input.id = label.htmlFor;

  const saveButton = document.createElement("button");
  saveButton.className = "column-wip-save";
  saveButton.type = "submit";
  saveButton.textContent = "Salvar limite";
  saveButton.hidden = !canManageWipLimits();
  saveButton.disabled = !boardReady || !canManageWipLimits();

  const removeButton = document.createElement("button");
  removeButton.className = "column-wip-remove";
  removeButton.type = "button";
  removeButton.textContent = "Remover";
  removeButton.disabled = !boardReady ||
    !canManageWipLimits() ||
    getColumnWipLimit(column) === null;
  removeButton.hidden = !canManageWipLimits();
  removeButton.addEventListener("click", () => {
    void saveColumnWipLimit(column, null);
  });

  const limitLabel = document.createElement("span");
  limitLabel.className = "column-wip-label";
  limitLabel.textContent = "Máximo";
  controls.append(limitLabel, label, input, saveButton, removeButton);
  return controls;
}

function startColumnWipListener(boardId) {
  stopColumnsListener?.();
  const unsubscribe = onSnapshot(
    collection(db, "boards", boardId, "columns"),
    (snapshot) => {
      if (currentBoard?.id !== boardId) return;
      snapshot.docs.forEach((columnDocument) => {
        const column = columns.find((item) => item.dataset.columnId === columnDocument.id);
        if (!column) return;
        const data = columnDocument.data();
        const limit = Number.isSafeInteger(data.wipLimit) && data.wipLimit >= 0
          ? data.wipLimit
          : null;
        updateColumnWipState(column, limit);
      });
    },
    (error) => {
      if (currentBoard?.id !== boardId) return;
      console.error("Erro ao acompanhar os limites WIP:", error);
      boardStatus.textContent = "Não foi possível atualizar os limites WIP das colunas.";
      boardStatus.classList.add("is-error");
    }
  );
  stopColumnsListener = unsubscribe;
}

function renderColumns(boardColumns) {
  boardElement.replaceChildren();
  columns = boardColumns.map((boardColumn, index) => {
    const column = document.createElement("section");
    column.className = "board-column";
    column.dataset.columnId = boardColumn.id;
    if (Number.isSafeInteger(boardColumn.wipLimit) && boardColumn.wipLimit >= 0) {
      column.dataset.wipLimit = String(boardColumn.wipLimit);
    }
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
    if (canManageWipLimits()) {
      header.append(createColumnWipControls(column, boardColumn));
    }

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
    const count = getColumnTaskCount(column.dataset.columnId);
    const limit = getColumnWipLimit(column);
    const counter = column.querySelector(".task-count");
    const reached = limit !== null && count >= limit;
    counter.textContent = limit === null ? String(count) : `${count}/${limit}`;
    counter.setAttribute(
      "aria-label",
      limit === null
        ? `${count} ${count === 1 ? "tarefa" : "tarefas"}`
        : `${count} de ${limit} tarefas${reached ? ", limite atingido" : ""}`
    );
    column.classList.toggle("is-wip-limit-reached", reached);
    const addButton = column.querySelector(".column-add-task");
    if (addButton) {
      addButton.disabled = !boardReady || !canEditTasks() || reached;
      addButton.title = reached ? "O limite desta coluna foi atingido." : "";
    }
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
  if (isWipLimitReached(column.dataset.columnId, task.id)) {
    const targetName = column.querySelector("h2").textContent;
    boardStatus.textContent = `Não foi possível mover a tarefa: a coluna "${targetName}" atingiu o limite WIP.`;
    boardStatus.classList.add("is-warning");
    boardStatus.classList.remove("is-error");
    announcement.textContent = boardStatus.textContent;
    return;
  }

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
  clearWipWarning();
  const heading = column.querySelector("h2").textContent;
  announcement.textContent = `Tarefa movida para ${heading}.`;
}

// Desenha o quadro na primeira carga da página.
renderBoard();

// Prepara o formulário para adicionar tarefa na coluna acionada.
function openTaskForm(event) {
  if (!boardReady || !canEditTasks()) return;
  const columnId = event.currentTarget.dataset.columnId;
  if (isWipLimitReached(columnId)) {
    boardStatus.textContent = "O limite WIP desta coluna foi atingido. Remova ou mova uma tarefa antes de adicionar outra.";
    boardStatus.classList.add("is-warning");
    boardStatus.classList.remove("is-error");
    return;
  }
  editingTaskId = null;
  taskForm.reset();
  taskForm.dataset.mode = "create";
  taskForm.dataset.columnId = columnId;
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
  clearWipWarning();
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
    if (taskRoute) {
      renderTaskDetail(task, taskDetailColumnName);
      announcement.textContent = `Tarefa "${title}" atualizada.`;
      closeDialog();
      return;
    }

    renderBoard();
    announcement.textContent = `Tarefa "${title}" atualizada.`;
    closeDialog();
    return;
  }

  // Para uma nova tarefa, confirma que o status selecionado corresponde a uma coluna.
  const column = columns.find((item) => item.dataset.columnId === taskForm.dataset.columnId);
  if (!title || !column) return;
  if (isWipLimitReached(column.dataset.columnId)) {
    closeDialog();
    boardStatus.textContent = "O limite WIP desta coluna foi atingido. Remova ou mova uma tarefa antes de adicionar outra.";
    boardStatus.classList.add("is-warning");
    boardStatus.classList.remove("is-error");
    return;
  }

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
  clearWipWarning();
  announcement.textContent = `Tarefa "${title}" adicionada em ${column.querySelector("h2").textContent}.`;
  closeDialog();
});

taskAssigneeSelect.addEventListener("change", () => {
  const task = tasks.find((item) => item.id === taskRoute?.taskId);
  if (task) {
    void saveTaskMetadata(
      task,
      { assigneeUid: taskAssigneeSelect.value },
      "Responsável atualizado."
    );
  }
});

taskPrioritySelect.addEventListener("change", () => {
  const task = tasks.find((item) => item.id === taskRoute?.taskId);
  if (task) {
    void saveTaskMetadata(
      task,
      { priority: taskPrioritySelect.value },
      "Prioridade atualizada."
    );
  }
});

taskLabelForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const task = tasks.find((item) => item.id === taskRoute?.taskId);
  if (!task || !canEditTasks() || isSavingTaskMetadata) return;

  const name = taskLabelName.value.trim();
  if (!name || name.length > 24) return;
  if (task.labels.length >= 20) {
    taskMetadataStatus.textContent = "Uma tarefa pode ter no máximo 20 etiquetas.";
    taskMetadataStatus.classList.remove("is-success");
    taskMetadataStatus.classList.add("is-error");
    return;
  }
  if (task.labels.some((label) =>
    label.name.toLocaleLowerCase() === name.toLocaleLowerCase()
  )) {
    taskMetadataStatus.textContent = "Esta etiqueta já foi adicionada à tarefa.";
    taskMetadataStatus.classList.remove("is-success");
    taskMetadataStatus.classList.add("is-error");
    return;
  }

  const labels = [
    ...task.labels,
    { name, color: taskLabelColor.value.toUpperCase() }
  ];
  const saved = await saveTaskMetadata(task, { labels }, "Etiqueta adicionada.");
  if (saved) taskLabelName.value = "";
});

taskDetailEditButton.addEventListener("click", () => {
  if (taskRoute) openEditForm(taskRoute.taskId);
});

taskCommentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!boardReady || !currentUser || !currentBoard || !canEditTasks()) return;

  const text = taskCommentText.value.trim();
  if (!text || text.length > 2000) return;

  taskCommentSubmit.disabled = true;
  taskCommentsStatus.textContent = "Publicando comentário...";
  taskCommentsStatus.classList.remove("is-error");
  try {
    await addDoc(taskCommentsCollection(), {
      text,
      authorUid: currentUser.uid,
      authorName: (currentUser.displayName || "").trim().slice(0, 100) || "Usuário",
      createdAt: serverTimestamp()
    });
    taskCommentForm.reset();
    taskCommentsStatus.textContent = "Comentário publicado.";
  } catch (error) {
    console.error("Erro ao publicar comentário:", error);
    taskCommentsStatus.textContent = error.code === "permission-denied"
      ? "O Firestore negou a publicação. As regras para comentários precisam ser atualizadas."
      : "Não foi possível publicar o comentário. Verifique sua conexão e tente novamente.";
    taskCommentsStatus.classList.add("is-error");
  } finally {
    taskCommentSubmit.disabled = false;
  }
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
    identity.textContent = getMemberDisplayName(member);
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
    const memberName = getMemberDisplayName(member);
    roleSelect.setAttribute("aria-label", `Papel de ${memberName}`);
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
    removeButton.setAttribute("aria-label", `Remover acesso de ${memberName}`);
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
    sender.textContent = `Enviado por ${invitation.ownerName || "proprietário do quadro"}`;
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
    const user = await getInvitationUser();
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
    const user = await getInvitationUser();
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
    await createBoardInvitation(
      db,
      board,
      currentUser.uid,
      email,
      role,
      currentUser.displayName
    );
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

deleteBoardButton.addEventListener("click", async () => {
  if (!canDeleteCurrentBoard()) return;

  const boardToDelete = currentBoard;
  if (!window.confirm(
    `Excluir o quadro "${boardToDelete.name}" e todas as suas tarefas, colunas, membros e convites? Esta ação não pode ser desfeita.`
  )) return;

  deleteBoardButton.disabled = true;
  boardStatus.classList.remove("is-error", "is-warning");
  boardStatus.textContent = "Excluindo o quadro e os dados associados...";

  try {
    await deleteOwnedBoard(db, boardToDelete.id, currentUser.uid);
    boards = await loadAccessibleBoards(db, currentUser.uid);
    if (boards.length === 0) {
      await createBoard(db, currentUser.uid, "Meu quadro");
      boards = await loadAccessibleBoards(db, currentUser.uid);
    }

    renderBoardSelector();
    const nextBoard = boards.find((board) => board.role === "owner") || boards[0];
    if (!nextBoard) {
      throw new Error("Nenhum quadro ficou disponível depois da exclusão.");
    }

    await openBoard(nextBoard);
    boardStatus.textContent = "Quadro excluído.";
  } catch (error) {
    console.error("Erro ao excluir o quadro:", error);
    boardStatus.textContent = error.code === "permission-denied"
      ? "O Firestore negou a exclusão. As regras precisam permitir que o proprietário liste e exclua as subcoleções do quadro."
      : error.message || "Não foi possível excluir o quadro.";
    boardStatus.classList.add("is-error");
    deleteBoardButton.disabled = false;
  }
});

setBoardControlsEnabled(false);
setTaskActionsEnabled(false);

// Espera o Firebase restaurar a sessão antes de carregar os dados privados.
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    stopTasksListener?.();
    stopTasksListener = null;
    stopColumnsListener?.();
    stopColumnsListener = null;
    stopCommentsListener?.();
    stopCommentsListener = null;
    stopBoardMembersListener?.();
    stopBoardMembersListener = null;
    boardMembers = [];
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
    if (taskRoute) {
      setTaskDetailStatus("Entre na sua conta para abrir esta tarefa.", true);
    }
    const loginUrl = new URL("login.html", document.baseURI);
    if (taskRoute) {
      loginUrl.searchParams.set(
        "returnUrl",
        `${window.location.pathname}${window.location.search}`
      );
    }
    window.location.replace(loginUrl.href);
    return;
  }
  currentUser = user;
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
    if (taskRoute) {
      await openTaskDetail(user);
      return;
    }

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
