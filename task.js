// Controla a leitura, a edição e os comentários da tarefa em um quadro compartilhado.
import { auth, db } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  onSnapshot,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Lê os identificadores da URL e reúne referências aos controles da página.
const parameters = new URLSearchParams(window.location.search);
const boardId = parameters.get("board") || "";
const taskId = parameters.get("id") || "";
const statusMessage = document.querySelector("#task-status");
const taskForm = document.querySelector("#task-form");
const fields = document.querySelector("#task-fields");
const saveButton = document.querySelector("#save-task");
const commentsSection = document.querySelector("#comments-section");
const commentForm = document.querySelector("#comment-form");
const commentList = document.querySelector("#comment-list");
const toast = document.querySelector("#task-toast");
const backLink = document.querySelector("#back-to-board");
const labelList = document.querySelector("#task-labels");
const checklistList = document.querySelector("#task-checklist");
const assigneeSelect = document.querySelector("#task-assignee");

// Guarda os dados recebidos pelos snapshots sem substituir a fonte em tempo real.
let currentUser = null;
let currentTask = null;
let currentRole = "VIEWER";
let canEdit = false;
let labels = [];
let checklist = [];
let members = [];
let toastTimeout = null;
let activeUid = null;
let unsubscribeMembers = null;
let unsubscribeTask = null;
let unsubscribeComments = null;
taskForm.hidden = true;
commentsSection.hidden = true;

// Exibe mensagens sem inserir texto de usuário como marcação HTML.
function showToast(message, type = "success") {
  toast.textContent = message;
  toast.className = `task-toast is-${type}`;
  toast.hidden = false;
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => {
    toast.hidden = true;
  }, 4000);
}

// Apresenta erros conhecidos com instruções úteis e mantém o erro no console.
function showError(message, error) {
  console.error(message, error);
  statusMessage.textContent = message;
  statusMessage.classList.add("is-error");
  showToast(message, "error");
}

// Valida os identificadores antes de usá-los como segmentos do caminho Firestore.
function hasValidIdentifiers() {
  return /^[A-Za-z0-9_-]{1,128}$/.test(boardId) &&
    /^[A-Za-z0-9_-]{1,128}$/.test(taskId);
}

// Constrói a referência à tarefa dentro do quadro indicado na URL.
function taskReference() {
  return doc(db, "boards", boardId, "tasks", taskId);
}

// Atualiza os controles de responsável com membros autorizados do quadro.
function renderAssignees(selectedId = "") {
  const previousId = selectedId || assigneeSelect.value;
  assigneeSelect.replaceChildren();
  const unassigned = document.createElement("option");
  unassigned.value = "";
  unassigned.textContent = "Sem responsável";
  assigneeSelect.append(unassigned);

  members.forEach((member) => {
    const option = document.createElement("option");
    option.value = member.id;
    option.textContent = member.name;
    assigneeSelect.append(option);
  });

  if (previousId && !members.some((member) => member.id === previousId)) {
    const missingMember = document.createElement("option");
    missingMember.value = previousId;
    missingMember.textContent = currentTask?.assigneeName || "Membro sem acesso";
    assigneeSelect.append(missingMember);
  }
  assigneeSelect.value = previousId;
}

// Renderiza as labels com operações de remoção disponíveis somente para editores.
function renderLabels() {
  labelList.replaceChildren();
  labels.forEach((text, index) => {
    const item = document.createElement("li");
    item.className = "task-label-chip";
    const label = document.createElement("span");
    label.textContent = text;
    item.append(label);
    if (canEdit) {
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.textContent = "×";
      removeButton.setAttribute("aria-label", `Remover label ${text}`);
      removeButton.addEventListener("click", () => {
        labels.splice(index, 1);
        renderLabels();
      });
      item.append(removeButton);
    }
    labelList.append(item);
  });
}

// Renderiza checklist, caixas de seleção e a contagem de progresso acessível.
function renderChecklist() {
  checklistList.replaceChildren();
  checklist.forEach((entry, index) => {
    const item = document.createElement("li");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = Boolean(entry.done);
    checkbox.disabled = !canEdit;
    checkbox.setAttribute("aria-label", `Marcar como concluído: ${entry.text}`);
    checkbox.addEventListener("change", () => {
      checklist[index].done = checkbox.checked;
      renderChecklist();
    });

    const text = document.createElement("span");
    text.textContent = entry.text;
    if (entry.done) text.classList.add("is-complete");
    item.append(checkbox, text);
    if (canEdit) {
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.textContent = "Remover";
      removeButton.setAttribute("aria-label", `Remover item: ${entry.text}`);
      removeButton.addEventListener("click", () => {
        checklist.splice(index, 1);
        renderChecklist();
      });
      item.append(removeButton);
    }
    checklistList.append(item);
  });

  const completed = checklist.filter((entry) => entry.done).length;
  const progress = document.querySelector("#checklist-progress");
  progress.max = checklist.length || 1;
  progress.value = completed;
  document.querySelector("#checklist-count").textContent = `${completed}/${checklist.length}`;
}

// Preenche o formulário a partir do snapshot e reflete as permissões do membro.
function renderTask() {
  if (!currentTask) return;
  taskForm.hidden = false;
  document.querySelector("#task-title").value = currentTask.title || "";
  document.querySelector("#task-description").value = currentTask.description || "";
  document.querySelector("#task-status-field").value = currentTask.status || "todo";
  document.querySelector("#task-due-date").value = /^\d{4}-\d{2}-\d{2}$/.test(currentTask.dueDate || "")
    ? currentTask.dueDate
    : "";
  document.querySelector("#task-priority").value = ["baixa", "média", "alta"].includes(currentTask.priority)
    ? currentTask.priority
    : "baixa";
  labels = Array.isArray(currentTask.labels)
    ? currentTask.labels.filter((label) => typeof label === "string")
    : [];
  checklist = Array.isArray(currentTask.checklist)
    ? currentTask.checklist
      .filter((entry) => entry && typeof entry.text === "string")
      .map((entry) => ({ text: entry.text, done: Boolean(entry.done) }))
    : [];

  renderAssignees(currentTask.assigneeId || "");
  renderLabels();
  renderChecklist();
  fields.disabled = !canEdit;
  saveButton.hidden = !canEdit;
  commentsSection.hidden = false;
  commentForm.hidden = !canEdit;
  statusMessage.textContent = canEdit ? "Tarefa atualizada em tempo real." : "Você tem acesso de leitura.";
  statusMessage.classList.remove("is-error");
}

// Converte o horário salvo para milissegundos, aceitando formatos antigos de Timestamp.
function commentTime(comment) {
  if (typeof comment.createdAt === "number") return comment.createdAt;
  if (typeof comment.createdAt?.toMillis === "function") return comment.createdAt.toMillis();
  return 0;
}

// Mostra comentários por data e hora com os nomes e textos tratados como texto simples.
function renderComments(snapshot) {
  commentList.replaceChildren();
  const orderedComments = snapshot.docs
    .map((commentDocument) => ({ ...commentDocument.data(), id: commentDocument.id }))
    .sort((first, second) => commentTime(first) - commentTime(second));

  orderedComments.forEach((comment) => {
    const item = document.createElement("li");
    item.className = "comment-item";
    const heading = document.createElement("div");
    heading.className = "comment-heading";
    const author = document.createElement("strong");
    author.textContent = comment.authorName || "Usuário";
    const time = document.createElement("time");
    const date = new Date(commentTime(comment));
    time.dateTime = date.toISOString();
    time.textContent = new Intl.DateTimeFormat("pt-BR", {
      dateStyle: "short",
      timeStyle: "short"
    }).format(date);
    const text = document.createElement("p");
    text.textContent = typeof comment.text === "string" ? comment.text : "";
    heading.append(author, time);
    item.append(heading, text);
    commentList.append(item);
  });
}

// Confere a associação antes de carregar qualquer dado da tarefa ou seus comentários.
async function loadAuthorizedTask() {
  if (!hasValidIdentifiers()) {
    showError("O link da tarefa está incompleto ou inválido.");
    return;
  }
  backLink.href = `index.html?board=${encodeURIComponent(boardId)}`;

  const membership = await getDoc(doc(db, "boards", boardId, "members", currentUser.uid));
  if (!membership.exists()) {
    statusMessage.textContent = "Você não tem acesso a este quadro.";
    statusMessage.classList.add("is-error");
    taskForm.hidden = true;
    commentsSection.hidden = true;
    return;
  }

  currentRole = String(membership.data().role || "").toUpperCase();
  canEdit = currentRole === "OWNER" || currentRole === "EDITOR";
  const membersReference = collection(db, "boards", boardId, "members");
  unsubscribeMembers = onSnapshot(membersReference, (snapshot) => {
    members = snapshot.docs.map((memberDocument) => {
      const member = memberDocument.data();
      return {
        id: memberDocument.id,
        name: member.name || member.displayName || member.email || memberDocument.id
      };
    });
    const ownMembership = snapshot.docs.find((memberDocument) => memberDocument.id === currentUser.uid);
    if (!ownMembership) {
      canEdit = false;
      fields.disabled = true;
      taskForm.hidden = true;
      commentsSection.hidden = true;
      statusMessage.textContent = "Você não tem acesso a este quadro.";
      statusMessage.classList.add("is-error");
      unsubscribeTask?.();
      unsubscribeComments?.();
      unsubscribeMembers?.();
      return;
    }
    currentRole = String(ownMembership.data().role || "").toUpperCase();
    canEdit = currentRole === "OWNER" || currentRole === "EDITOR";
    if (currentTask) renderTask();
  }, (error) => showError("Não foi possível carregar os membros do quadro.", error));

  unsubscribeTask = onSnapshot(taskReference(), (snapshot) => {
    if (!snapshot.exists()) {
      currentTask = null;
      taskForm.hidden = true;
      statusMessage.textContent = "Esta tarefa não existe ou foi removida.";
      statusMessage.classList.add("is-error");
      return;
    }
    currentTask = snapshot.data();
    renderTask();
  }, (error) => showError("Não foi possível carregar a tarefa. Verifique sua conexão e suas permissões.", error));

  unsubscribeComments = onSnapshot(collection(db, "boards", boardId, "tasks", taskId, "comments"), renderComments, (error) => {
    showError("Não foi possível carregar os comentários da tarefa.", error);
  });
}

// Inclui uma label digitada apenas quando ela não existe na lista atual.
function addLabel(value) {
  if (!canEdit) return;
  const label = value.trim();
  if (!label || labels.some((existing) => existing.toLocaleLowerCase("pt-BR") === label.toLocaleLowerCase("pt-BR"))) {
    return;
  }
  labels.push(label);
  renderLabels();
}

// Inclui um item pendente no checklist sem aceitar conteúdo vazio.
function addChecklistItem() {
  if (!canEdit) return;
  const input = document.querySelector("#checklist-input");
  const text = input.value.trim();
  if (!text) {
    input.focus();
    return;
  }
  checklist.push({ text, done: false });
  input.value = "";
  renderChecklist();
  input.focus();
}

// Persiste os campos, labels e checklist somente para OWNER e EDITOR.
taskForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!canEdit || !currentTask || !taskForm.reportValidity()) return;

  const title = document.querySelector("#task-title").value.trim();
  if (!title) {
    document.querySelector("#task-title").focus();
    return;
  }
  const selectedMember = members.find((member) => member.id === assigneeSelect.value);
  const keepUnavailableAssignee = assigneeSelect.value === (currentTask.assigneeId || "");
  const changes = {
    title,
    description: document.querySelector("#task-description").value.trim(),
    status: document.querySelector("#task-status-field").value,
    assigneeId: selectedMember?.id || (keepUnavailableAssignee ? currentTask.assigneeId || "" : ""),
    assigneeName: selectedMember?.name || (keepUnavailableAssignee ? currentTask.assigneeName || "" : ""),
    dueDate: document.querySelector("#task-due-date").value,
    priority: document.querySelector("#task-priority").value,
    labels: [...labels],
    checklist: checklist.map((entry) => ({ text: entry.text, done: Boolean(entry.done) }))
  };
  saveButton.disabled = true;
  try {
    await updateDoc(taskReference(), changes);
    showToast("Alterações salvas com sucesso.");
  } catch (error) {
    showError(error.code === "permission-denied"
      ? "Você não tem permissão para editar esta tarefa."
      : "Não foi possível salvar as alterações. Tente novamente.", error);
  } finally {
    saveButton.disabled = false;
  }
});

// Registra comentários com identidade autenticada e data numérica em milissegundos.
commentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!canEdit || !currentUser) return;
  const textField = document.querySelector("#comment-text");
  const text = textField.value.trim();
  if (!text) {
    textField.focus();
    return;
  }
  const submitButton = commentForm.querySelector('[type="submit"]');
  submitButton.disabled = true;
  try {
    await addDoc(collection(db, "boards", boardId, "tasks", taskId, "comments"), {
      authorId: currentUser.uid,
      authorName: currentUser.displayName || currentUser.email || "Usuário",
      text,
      createdAt: Date.now()
    });
    textField.value = "";
    showToast("Comentário publicado com sucesso.");
  } catch (error) {
    showError(error.code === "permission-denied"
      ? "Você não tem permissão para comentar nesta tarefa."
      : "Não foi possível publicar o comentário. Tente novamente.", error);
  } finally {
    submitButton.disabled = false;
  }
});

// Liga a criação de labels, sugestões e itens do checklist aos controles da interface.
document.querySelector("#add-label").addEventListener("click", () => {
  const input = document.querySelector("#label-input");
  addLabel(input.value);
  input.value = "";
});
document.querySelector("#label-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    document.querySelector("#add-label").click();
  }
});
document.querySelectorAll("[data-label-suggestion]").forEach((button) => {
  button.addEventListener("click", () => addLabel(button.dataset.labelSuggestion));
});
document.querySelector("#add-checklist-item").addEventListener("click", addChecklistItem);
document.querySelector("#checklist-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addChecklistItem();
  }
});

// Aguarda a restauração da sessão e guarda o endereço atual antes de pedir autenticação.
onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (!user) {
    activeUid = null;
    const returnUrl = `${window.location.pathname.split("/").pop()}${window.location.search}${window.location.hash}`;
    sessionStorage.setItem("trilha-return-url", returnUrl);
    window.location.replace("index.html");
    return;
  }
  if (activeUid === user.uid) return;
  activeUid = user.uid;
  try {
    await loadAuthorizedTask();
  } catch (error) {
    const denied = error.code === "permission-denied";
    if (denied) {
      taskForm.hidden = true;
      commentsSection.hidden = true;
    }
    showError(denied
      ? "Você não tem acesso a este quadro."
      : "Não foi possível abrir a tarefa. Confira a conexão e o link.", error);
  }
});
