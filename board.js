// Importa os serviços Firebase e as operações de sessão e dados do quadro.
import { auth, db } from "./firebase-config.js";
import {
  onAuthStateChanged,
  EmailAuthProvider,
  reauthenticateWithCredential,
  signOut,
  updatePassword,
  updateProfile,
  verifyBeforeUpdateEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getAuthErrorMessage } from "./auth.js";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Mantém em memória o usuário validado antes de iniciar operações do quadro.
let currentUser = null;
// Guarda o quadro atual e o papel validado antes de permitir qualquer gravação.
let currentBoardId = new URLSearchParams(window.location.search).get("board");
let currentRole = "VIEWER";
let canEditTasks = false;
let activeUid = null;
let unsubscribeTasks = null;
let unsubscribeMembers = null;
const memberNames = new Map();
const memberDialog = document.querySelector("#member-dialog");
const memberForm = document.querySelector("#member-form");
const memberMessage = document.querySelector("#member-message");
const shareBoardButton = document.querySelector("#share-board-button");
// Guarda as colunas renderizadas no HTML para atualizar e tratar arrastes.
const columns = [...document.querySelectorAll(".board-column")];
// Referências aos formulários, caixas de diálogo e avisos acessíveis do quadro.
const dialog = document.querySelector("#task-dialog");
const taskForm = document.querySelector("#task-form");
const announcement = document.querySelector("#board-announcement");
const boardStatus = document.querySelector("#board-status");
const deleteDialog = document.querySelector("#delete-dialog");
const deleteMessage = document.querySelector("#delete-confirmation-message");
const boardActionButtons = [...document.querySelectorAll(".column-add-task")];
const editAccountButton = document.querySelector("#edit-account-button");
boardActionButtons.forEach((button) => {
  button.disabled = true;
});
editAccountButton.disabled = true;
// Guarda os identificadores temporários usados ao arrastar, editar e excluir tarefas.
let draggedTaskId = null;
let editingTaskId = null;
let pendingDeleteTaskId = null;

// Constrói caminhos Firestore dentro do quadro autorizado selecionado.
function tasksCollection() {
  return collection(db, "boards", currentBoardId, "tasks");
}

// Mantém o caminho antigo disponível somente para migrar os dados do próprio usuário.
function legacyTasksCollection(userId = currentUser.uid) {
  return collection(db, "users", userId, "tasks");
}

// Confere se cada registro salvo contém os campos e status aceitos pelo quadro.
function isValidTask(task) {
  return task &&
    typeof task.id === "string" &&
    typeof task.title === "string" &&
    typeof task.status === "string" &&
    ["todo", "progress", "review", "done"].includes(task.status);
}

// Mantém em memória os documentos carregados para o usuário autenticado.
let tasks = [];

// Cria um quadro pessoal quando necessário e migra tarefas antigas sem sobrescrever dados.
async function initializePersonalBoard(user) {
  currentBoardId = `personal-${user.uid}`;
  const boardReference = doc(db, "boards", currentBoardId);
  const displayName = user.displayName || user.email || "Usuário";

  await setDoc(boardReference, {
    name: "Trilha",
    ownerId: user.uid
  }, { merge: true });
  const ownerMemberReference = doc(boardReference, "members", user.uid);
  const ownerMembership = await getDoc(ownerMemberReference);
  if (!ownerMembership.exists()) {
    await setDoc(ownerMemberReference, {
      uid: user.uid,
      name: displayName,
      email: user.email || "",
      role: "OWNER",
      joinedAt: serverTimestamp()
    });
  }

  const [legacySnapshot, currentSnapshot] = await Promise.all([
    getDocs(legacyTasksCollection(user.uid)),
    getDocs(tasksCollection())
  ]);
  const existingIds = new Set(currentSnapshot.docs.map((taskDocument) => taskDocument.id));
  const oldTasks = legacySnapshot.docs.filter((taskDocument) => !existingIds.has(taskDocument.id));
  await Promise.all(oldTasks.map((taskDocument) => setDoc(
    doc(tasksCollection(), taskDocument.id),
    taskDocument.data()
  )));
}

// Escuta tarefas e membros em tempo real para refletir alterações compartilhadas no quadro.
function subscribeToBoard() {
  unsubscribeTasks?.();
  unsubscribeMembers?.();

  unsubscribeTasks = onSnapshot(tasksCollection(), (snapshot) => {
    const loadedTasks = snapshot.docs.map((taskDocument) => ({
      ...taskDocument.data(),
      id: taskDocument.id
    }));
    if (!loadedTasks.every(isValidTask)) {
      reportFirestoreError("carregar", new Error("O Firestore contém dados de tarefa em formato inválido."));
      return;
    }
    tasks = loadedTasks.map((task) => ({
      ...task,
      description: typeof task.description === "string" ? task.description : ""
    }));
    renderBoard();
    boardStatus.textContent = "";
  }, (error) => reportFirestoreError("carregar", error));

  unsubscribeMembers = onSnapshot(collection(db, "boards", currentBoardId, "members"), (snapshot) => {
    memberNames.clear();
    snapshot.docs.forEach((memberDocument) => {
      const member = memberDocument.data();
      memberNames.set(memberDocument.id, member.name || member.displayName || member.email || memberDocument.id);
    });
    const ownMembership = snapshot.docs.find((memberDocument) => memberDocument.id === currentUser.uid);
    if (!ownMembership) {
      canEditTasks = false;
      currentRole = "VIEWER";
      boardActionButtons.forEach((button) => { button.disabled = true; });
      shareBoardButton.hidden = true;
      unsubscribeTasks?.();
      tasks = [];
      renderBoard();
      boardStatus.textContent = "Você não tem acesso a este quadro.";
      boardStatus.classList.add("is-error");
      return;
    }
    currentRole = String(ownMembership.data().role || "").toUpperCase();
    canEditTasks = currentRole === "OWNER" || currentRole === "EDITOR";
    boardActionButtons.forEach((button) => { button.disabled = !canEditTasks; });
    shareBoardButton.hidden = currentRole !== "OWNER";
    renderBoard();
  }, (error) => reportFirestoreError("carregar membros", error));
}

// Confere a associação do usuário ao quadro e aplica o papel antes de iniciar os listeners.
async function openBoardForUser(user) {
  if (!currentBoardId) {
    await initializePersonalBoard(user);
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(currentBoardId)) {
    boardStatus.textContent = "O identificador do quadro é inválido.";
    boardStatus.classList.add("is-error");
    return false;
  }
  const membership = await getDoc(doc(db, "boards", currentBoardId, "members", user.uid));
  if (!membership.exists()) {
    boardStatus.textContent = "Você não tem acesso a este quadro.";
    boardStatus.classList.add("is-error");
    boardActionButtons.forEach((button) => { button.disabled = true; });
    shareBoardButton.hidden = true;
    return false;
  }

  currentRole = String(membership.data().role || "").toUpperCase();
  canEditTasks = currentRole === "OWNER" || currentRole === "EDITOR";
  boardActionButtons.forEach((button) => { button.disabled = !canEditTasks; });
  editAccountButton.disabled = false;
  shareBoardButton.hidden = currentRole !== "OWNER";
  subscribeToBoard();
  return true;
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
  card.draggable = true;
  card.tabIndex = 0;
  card.dataset.taskId = task.id;
  card.dataset.status = task.status;
  card.setAttribute("aria-label", `${task.title}. Arraste para mover entre colunas.`);

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

  // Exibe responsável, prioridade, prazo, labels e andamento do checklist sem interpolar HTML.
  const details = document.createElement("div");
  details.className = "task-card-details";
  const assignee = document.createElement("span");
  assignee.className = "task-card-assignee";
  assignee.textContent = task.assigneeName ||
    (task.assigneeId ? memberNames.get(task.assigneeId) : "") ||
    "Sem responsável";
  details.append(assignee);

  if (typeof task.priority === "string" && task.priority) {
    const priority = document.createElement("span");
    priority.className = `task-priority priority-${task.priority.normalize("NFD").replace(/[\u0300-\u036f]/g, "")}`;
    priority.textContent = `Prioridade ${task.priority}`;
    details.append(priority);
  }

  if (typeof task.dueDate === "string" && task.dueDate) {
    const dueDate = document.createElement("span");
    const today = new Date();
    const localToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const isOverdue = /^\d{4}-\d{2}-\d{2}$/.test(task.dueDate) &&
      task.dueDate < localToday && task.status !== "done";
    dueDate.className = isOverdue ? "task-due-date is-overdue" : "task-due-date";
    dueDate.textContent = `Prazo: ${new Date(`${task.dueDate}T00:00:00`).toLocaleDateString("pt-BR")}`;
    details.append(dueDate);
  }
  card.append(details);

  if (Array.isArray(task.labels) && task.labels.some((label) => typeof label === "string")) {
    const labels = document.createElement("div");
    labels.className = "task-card-labels";
    task.labels.filter((labelText) => typeof labelText === "string").forEach((labelText) => {
      const label = document.createElement("span");
      label.className = "task-label-chip";
      label.textContent = labelText;
      labels.append(label);
    });
    card.append(labels);
  }

  if (Array.isArray(task.checklist) && task.checklist.length) {
    const checklist = document.createElement("span");
    checklist.className = "task-checklist-count";
    const completed = task.checklist.filter((item) => item && item.done).length;
    checklist.textContent = `Checklist ${completed}/${task.checklist.length}`;
    card.append(checklist);
  }

  // Cria as ações permitidas pelo papel, mantendo a abertura da tarefa disponível a todos.
  const actions = document.createElement("div");
  actions.className = "task-actions";
  const openLink = document.createElement("a");
  openLink.className = "task-action-button task-open-link";
  openLink.textContent = "Abrir ↗";
  openLink.href = `task.html?board=${encodeURIComponent(currentBoardId)}&id=${encodeURIComponent(task.id)}`;
  openLink.target = "_blank";
  openLink.rel = "noopener";
  openLink.setAttribute("aria-label", `Abrir tarefa: ${task.title}`);
  actions.append(openLink);

  if (canEditTasks) {
    const editButton = document.createElement("button");
    editButton.className = "task-action-button";
    editButton.type = "button";
    editButton.textContent = "✎";
    editButton.setAttribute("aria-label", `Editar tarefa: ${task.title}`);
    editButton.addEventListener("click", () => openEditForm(task.id));

    const deleteButton = document.createElement("button");
    deleteButton.className = "task-action-button task-delete-button";
    deleteButton.type = "button";
    deleteButton.textContent = "Excluir";
    deleteButton.setAttribute("aria-label", `Excluir tarefa: ${task.title}`);
    deleteButton.addEventListener("click", () => deleteTask(task.id));
    actions.append(editButton, deleteButton);
  }
  card.append(actions);

  // Inicia o arraste apenas a partir do cartão, não dos botões internos.
  card.addEventListener("dragstart", (event) => {
    if (!canEditTasks || event.target.closest("button, a")) {
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
      .filter((task) => task.status === column.dataset.status)
      .forEach((task) => cardList.append(createTaskCard(task)));
  });
  updateTaskCounts();
}

// Move a tarefa para outra coluna, salva a mudança e anuncia o resultado.
async function moveTask(card, column) {
  if (!canEditTasks) return;
  const task = tasks.find((item) => item.id === card.dataset.taskId);
  if (!task || task.status === column.dataset.status) return;

  try {
    await updateDoc(doc(tasksCollection(), task.id), { status: column.dataset.status });
  } catch (error) {
    reportFirestoreError("mover", error);
    return;
  }

  task.status = column.dataset.status;
  renderBoard();
  const heading = column.querySelector("h2").textContent;
  announcement.textContent = `Tarefa movida para ${heading}.`;
}

// Desenha o quadro na primeira carga da página.
renderBoard();

// Configura o comportamento de arraste e soltura em cada coluna.
columns.forEach((column) => {
  column.addEventListener("dragover", (event) => {
    if (!draggedTaskId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    column.classList.add("is-over");
  });

  column.addEventListener("dragleave", (event) => {
    if (!column.contains(event.relatedTarget)) column.classList.remove("is-over");
  });

  column.addEventListener("drop", (event) => {
    event.preventDefault();
    if (draggedTaskId) {
      const card = [...document.querySelectorAll(".task-card")]
        .find((item) => item.dataset.taskId === draggedTaskId);
      if (card) void moveTask(card, column);
    }
    column.classList.remove("is-over");
  });
});

// Prepara o formulário para adicionar tarefa na coluna acionada.
function openTaskForm(event) {
  if (!canEditTasks) return;
  editingTaskId = null;
  taskForm.reset();
  taskForm.dataset.mode = "create";
  taskForm.dataset.status = event.currentTarget.dataset.status;
  document.querySelector("#dialog-title").textContent = "Adicionar tarefa";
  document.querySelector("#task-submit").textContent = "Adicionar tarefa";
  dialog.showModal();
  document.querySelector("#task-title").focus();
}

// Preenche o formulário com os dados existentes para permitir a edição.
function openEditForm(taskId) {
  if (!canEditTasks) return;
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
  if (!canEditTasks) return;
  const task = tasks.find((item) => item.id === taskId);
  if (!task) return;

  pendingDeleteTaskId = taskId;
  deleteMessage.textContent = `Tem certeza de que deseja excluir “${task.title}”? Esta ação não pode ser desfeita.`;
  deleteDialog.showModal();
  document.querySelector("#cancel-delete").focus();
}

// Exclui a tarefa confirmada e atualiza o quadro.
async function confirmDeleteTask() {
  if (!canEditTasks) return;
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

// Abre o formulário de criação ao clicar em qualquer botão de nova tarefa.
document.querySelectorAll(".column-add-task").forEach((button) => {
  button.addEventListener("click", (event) => openTaskForm(event));
});

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
  if (!canEditTasks) return;
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
      await updateDoc(doc(tasksCollection(), task.id), { title, description });
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
  const column = columns.find((item) => item.dataset.status === taskForm.dataset.status);
  if (!title || !column) return;

  // Cria um identificador único e adiciona a tarefa ao estado do quadro.
  const newTask = {
    title,
    description,
    status: taskForm.dataset.status,
    assigneeId: "",
    assigneeName: "",
    dueDate: "",
    priority: "baixa",
    labels: [],
    checklist: [],
    createdAt: serverTimestamp()
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

// Abre o formulário de compartilhamento apenas para o proprietário do quadro.
shareBoardButton.addEventListener("click", () => {
  if (currentRole !== "OWNER") return;
  memberForm.reset();
  memberMessage.textContent = "";
  memberDialog.showModal();
  document.querySelector("#member-uid").focus();
});

// Adiciona ou atualiza um membro respeitando o papel OWNER no cliente e nas regras.
memberForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (currentRole !== "OWNER") return;
  const memberUid = document.querySelector("#member-uid").value.trim();
  const name = document.querySelector("#member-name").value.trim();
  const role = document.querySelector("#member-role").value;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(memberUid) || !name || !["EDITOR", "VIEWER"].includes(role)) {
    memberMessage.textContent = "Informe um UID válido, um nome e um papel permitido.";
    return;
  }
  if (memberUid === currentUser.uid) {
    memberMessage.textContent = "O proprietário já tem acesso ao quadro.";
    return;
  }

  const submitButton = memberForm.querySelector('[type="submit"]');
  submitButton.disabled = true;
  try {
    await setDoc(doc(db, "boards", currentBoardId, "members", memberUid), {
      uid: memberUid,
      name,
      role,
      joinedAt: serverTimestamp()
    }, { merge: true });
    memberMessage.textContent = "Acesso ao quadro atualizado com sucesso.";
    memberForm.reset();
  } catch (error) {
    console.error("Erro ao compartilhar quadro no Firestore:", error);
    memberMessage.textContent = error.code === "permission-denied"
      ? "Somente o proprietário pode compartilhar este quadro."
      : "Não foi possível compartilhar o quadro. Confira a conexão e tente novamente.";
  } finally {
    submitButton.disabled = false;
  }
});

// Fecha o diálogo de compartilhamento sem alterar os acessos existentes.
document.querySelector("#close-member-dialog").addEventListener("click", () => memberDialog.close());
document.querySelector("#cancel-member-dialog").addEventListener("click", () => memberDialog.close());

// Espera o Firebase restaurar a sessão antes de carregar os dados privados.
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    activeUid = null;
    currentUser = null;
    unsubscribeTasks?.();
    unsubscribeMembers?.();
    boardActionButtons.forEach((button) => {
      button.disabled = true;
    });
    boardStatus.textContent = "Sessão não encontrada. Redirecionando para o login...";
    sessionStorage.setItem(
      "trilha-return-url",
      currentBoardId ? `board.html?board=${encodeURIComponent(currentBoardId)}` : "board.html"
    );
    window.location.replace("login.html");
    return;
  }

  if (activeUid === user.uid) return;
  activeUid = user.uid;
  currentUser = user;
  boardStatus.textContent = "Conectado. Carregando o quadro...";
  boardStatus.classList.remove("is-error");
  boardActionButtons.forEach((button) => { button.disabled = true; });
  editAccountButton.disabled = false;
  const displayName = user.displayName || user.email || "Usuário";
  userNameElement.textContent = displayName;
  userAvatarElement.textContent = displayName
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");

  try {
    await openBoardForUser(user);
  } catch (error) {
    console.error("Erro ao carregar tarefas do Firestore:", error);
    const message = error.code === "permission-denied" && new URLSearchParams(window.location.search).has("board")
      ? "Você não tem acesso a este quadro."
      : error.code === "permission-denied"
        ? "O Firestore negou o acesso. Publique as regras do arquivo firestore.rules no projeto Firebase."
      : error.code === "unavailable"
        ? "O Firebase está indisponível. Verifique sua conexão com a internet."
        : error.code === "not-found"
          ? "O banco Firestore ainda não foi criado neste projeto."
          : "Não foi possível carregar o quadro. Confira a conexão e as configurações do Firebase.";
    boardStatus.textContent = message;
    boardStatus.classList.add("is-error");
    announcement.textContent = message;
  }
});
