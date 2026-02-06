const STORAGE_KEY = "kanban-board-v1";
const columns = ["todo", "doing", "done"];
const labels = {
  todo: "Da fare",
  doing: "In corso",
  done: "Fatto",
};

const addTaskButton = document.getElementById("addTaskButton");
const dialog = document.getElementById("taskDialog");
const taskForm = document.getElementById("taskForm");
const cancelTask = document.getElementById("cancelTask");
const taskTitle = document.getElementById("taskTitle");
const taskDescription = document.getElementById("taskDescription");
const taskTemplate = document.getElementById("taskTemplate");

let board = loadBoard();
renderBoard();
registerServiceWorker();

addTaskButton.addEventListener("click", () => {
  taskForm.reset();
  dialog.showModal();
  taskTitle.focus();
});

cancelTask.addEventListener("click", () => {
  dialog.close();
});

taskForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const title = taskTitle.value.trim();
  if (!title) {
    taskTitle.focus();
    return;
  }
  const description = taskDescription.value.trim();
  const task = {
    id: crypto.randomUUID(),
    title,
    description,
    status: "todo",
    createdAt: Date.now(),
  };
  board.tasks.unshift(task);
  saveBoard();
  renderBoard();
  dialog.close();
});

function renderBoard() {
  columns.forEach((column) => {
    const list = document.querySelector(`[data-list="${column}"]`);
    list.innerHTML = "";
    const tasks = board.tasks.filter((task) => task.status === column);
    tasks.forEach((task) => {
      const node = createTaskNode(task);
      list.append(node);
    });
    list.addEventListener("dragover", handleDragOver);
    list.addEventListener("drop", handleDrop);
  });
}

function createTaskNode(task) {
  const fragment = taskTemplate.content.cloneNode(true);
  const article = fragment.querySelector(".task");
  const title = fragment.querySelector(".task-title");
  const desc = fragment.querySelector(".task-desc");
  const badge = fragment.querySelector(".badge");
  const deleteButton = fragment.querySelector("[data-action='delete']");

  article.dataset.taskId = task.id;
  title.textContent = task.title;
  desc.textContent = task.description || "Nessuna descrizione";
  badge.textContent = labels[task.status];
  badge.dataset.status = task.status;

  article.addEventListener("dragstart", handleDragStart);
  article.addEventListener("dragend", handleDragEnd);
  deleteButton.addEventListener("click", () => removeTask(task.id));

  return fragment;
}

function handleDragStart(event) {
  const task = event.currentTarget;
  task.classList.add("dragging");
  event.dataTransfer.setData("text/plain", task.dataset.taskId);
  event.dataTransfer.effectAllowed = "move";
}

function handleDragEnd(event) {
  event.currentTarget.classList.remove("dragging");
}

function handleDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
}

function handleDrop(event) {
  event.preventDefault();
  const taskId = event.dataTransfer.getData("text/plain");
  const list = event.currentTarget;
  const column = list.dataset.list;
  if (!taskId || !column) return;
  moveTask(taskId, column);
}

function moveTask(taskId, status) {
  board.tasks = board.tasks.map((task) =>
    task.id === taskId ? { ...task, status } : task
  );
  saveBoard();
  renderBoard();
}

function removeTask(taskId) {
  board.tasks = board.tasks.filter((task) => task.id !== taskId);
  saveBoard();
  renderBoard();
}

function loadBoard() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    return {
      tasks: [
        {
          id: crypto.randomUUID(),
          title: "Disegna la nuova landing",
          description: "Idee su colori e tipografia",
          status: "todo",
          createdAt: Date.now(),
        },
        {
          id: crypto.randomUUID(),
          title: "Allinea il backlog",
          description: "Priorità Q2",
          status: "doing",
          createdAt: Date.now(),
        },
        {
          id: crypto.randomUUID(),
          title: "Pubblica la demo",
          description: "Checklist QA completata",
          status: "done",
          createdAt: Date.now(),
        },
      ],
    };
  }
  return JSON.parse(stored);
}

function saveBoard() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(board));
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js");
    });
  }
}
