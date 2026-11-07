const initialTasks = [];
const columns = [...document.querySelectorAll(".board-column")];
const dialog = document.querySelector("#task-dialog");
const taskForm = document.querySelector("#task-form");
const announcement = document.querySelector("#board-announcement");
const STORAGE_KEY = "jurisflow-board-tasks";
let draggedTaskId = null;
let editingTaskId = null;

function isValidTask(task) {
  return task &&
    typeof task.id === "string" &&
    typeof task.title === "string" &&
    typeof task.status === "string" &&
    ["todo", "progress", "review", "done"].includes(task.status);
}

function loadTasks() {
  try {
    const savedTasks = localStorage.getItem(STORAGE_KEY);
    if (savedTasks === null) return initialTasks.map((task) => ({ ...task }));

    const parsedTasks = JSON.parse(savedTasks);
    if (!Array.isArray(parsedTasks) || !parsedTasks.every(isValidTask)) {
      throw new Error("Os dados salvos do quadro estão em um formato inválido.");
    }

    return parsedTasks.map((task) => ({
      ...task,
      description: typeof task.description === "string" ? task.description : ""
    }));
  } catch (error) {
    announcement.textContent = "Não foi possível carregar as tarefas salvas. O quadro inicial foi carregado.";
    console.error("Erro ao carregar tarefas do localStorage:", error);
    return initialTasks.map((task) => ({ ...task }));
  }
}

let tasks = loadTasks();

function saveTasks() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    return true;
  } catch (error) {
    announcement.textContent = "Não foi possível salvar as alterações neste navegador.";
    console.error("Erro ao salvar tarefas no localStorage:", error);
    return false;
  }
}

function createTaskCard(task) {
  const card = document.createElement("article");
  card.className = "task-card";
  card.draggable = true;
  card.tabIndex = 0;
  card.dataset.taskId = task.id;
  card.dataset.status = task.status;
  card.setAttribute("aria-label", `${task.title}. Arraste para mover entre colunas.`);

  const title = document.createElement("h3");
  title.textContent = task.title;

  card.append(title);

  if (task.description) {
    const description = document.createElement("p");
    description.className = "task-description";
    description.textContent = task.description;
    card.append(description);
  }

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

  card.addEventListener("dragstart", (event) => {
    if (event.target.closest("button")) {
      event.preventDefault();
      return;
    }
    draggedTaskId = task.id;
    card.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", task.title);
  });

  card.addEventListener("dragend", () => {
    card.classList.remove("is-dragging");
    columns.forEach((column) => column.classList.remove("is-over"));
    draggedTaskId = null;
  });

  return card;
}

function updateTaskCounts() {
  columns.forEach((column) => {
    const count = column.querySelector(".card-list").children.length;
    const counter = column.querySelector(".task-count");
    counter.textContent = count;
    counter.setAttribute("aria-label", `${count} ${count === 1 ? "tarefa" : "tarefas"}`);
  });
}

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

function moveTask(card, column) {
  const task = tasks.find((item) => item.id === card.dataset.taskId);
  if (!task || task.status === column.dataset.status) return;
  task.status = column.dataset.status;
  saveTasks();
  renderBoard();
  const heading = column.querySelector("h2").textContent;
  announcement.textContent = `Tarefa movida para ${heading}.`;
}

renderBoard();

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
      if (card) moveTask(card, column);
    }
    column.classList.remove("is-over");
  });
});

function openTaskForm(event) {
  editingTaskId = null;
  taskForm.reset();
  taskForm.dataset.mode = "create";
  taskForm.dataset.status = event.currentTarget.dataset.status;
  document.querySelector("#dialog-title").textContent = "Adicionar tarefa";
  document.querySelector("#task-submit").textContent = "Adicionar tarefa";
  dialog.showModal();
  document.querySelector("#task-title").focus();
}

function openEditForm(taskId) {
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

function deleteTask(taskId) {
  const task = tasks.find((item) => item.id === taskId);
  if (!task || !window.confirm(`Tem certeza de que deseja excluir "${task.title}"?`)) return;

  tasks = tasks.filter((item) => item.id !== taskId);
  saveTasks();
  renderBoard();
  announcement.textContent = `Tarefa "${task.title}" excluída.`;
}

document.querySelectorAll(".column-add-task").forEach((button) => {
  button.addEventListener("click", (event) => openTaskForm(event));
});

function closeDialog() {
  dialog.close();
  taskForm.reset();
  editingTaskId = null;
}

document.querySelector("#close-task-form").addEventListener("click", closeDialog);
document.querySelector("#cancel-task-form").addEventListener("click", closeDialog);

taskForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!taskForm.reportValidity()) return;

  const formData = new FormData(taskForm);
  const title = formData.get("title").trim();
  const description = formData.get("description").trim();

  if (!title) return;

  if (taskForm.dataset.mode === "edit" && editingTaskId) {
    const task = tasks.find((item) => item.id === editingTaskId);
    if (!task) return;
    task.title = title;
    task.description = description;
    saveTasks();
    renderBoard();
    announcement.textContent = `Tarefa "${title}" atualizada.`;
    closeDialog();
    return;
  }

  const column = columns.find((item) => item.dataset.status === taskForm.dataset.status);
  if (!title || !column) return;

  tasks.push({
    id: window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    title,
    description,
    status: taskForm.dataset.status
  });
  saveTasks();
  renderBoard();
  announcement.textContent = `Tarefa "${title}" adicionada em ${column.querySelector("h2").textContent}.`;
  closeDialog();
});

dialog.addEventListener("click", (event) => {
  if (event.target === dialog) closeDialog();
});