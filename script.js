// Redireciona links index.html?board=... para a tela do quadro correspondente.

// Encaminha o link de retorno de uma tarefa sem descartar o identificador do quadro.
const boardId = new URLSearchParams(window.location.search).get("board");
if (boardId) {
  const destination = new URL("board.html", window.location.href);
  destination.searchParams.set("board", boardId);
  window.location.replace(destination.href);
}
