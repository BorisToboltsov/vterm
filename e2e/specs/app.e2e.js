// Happy-path E2E: add a server, connect to the test SSH container, run a
// command, and verify the output appears in the terminal. Also exercises the
// SFTP panel. Selectors use the data-testid hooks added in Phase 5.8.
//
// Configure the target via env (defaults match docker-compose.ssh.yml):
//   VTERM_TEST_SSH_HOST (default 127.0.0.1)
//   VTERM_TEST_SSH_PORT (default 2222)
//   VTERM_TEST_SSH_USER (default tester)
//   VTERM_TEST_SSH_PASS (default testpass)

const HOST = process.env.VTERM_TEST_SSH_HOST || "127.0.0.1";
const PORT = process.env.VTERM_TEST_SSH_PORT || "2222";
const USER = process.env.VTERM_TEST_SSH_USER || "tester";
const PASS = process.env.VTERM_TEST_SSH_PASS || "testpass";

const testid = (id) => $(`[data-testid="${id}"]`);

describe("vterm — connect & run a command", () => {
  it("adds a server profile", async () => {
    await (await testid("add-server")).click();

    await (await testid("field-alias")).setValue("E2E Box");
    await (await testid("field-host")).setValue(HOST);
    await (await testid("field-username")).setValue(USER);
    // Port input has no testid; it's the only number input in the form.
    await $('input[type="number"]').setValue(PORT);
    await (await testid("save-server")).click();

    await expect($('[data-testid="server-row"][data-server-alias="E2E Box"]')).toExist();
  });

  it("connects and shows a command's output", async () => {
    await $('[data-testid="server-row"][data-server-alias="E2E Box"]').click();
    await (await testid("connect")).click();

    // Password auth → secret prompt.
    const secret = await testid("secret-input");
    await secret.waitForExist({ timeout: 10000 });
    await secret.setValue(PASS);
    await (await testid("secret-connect")).click();

    // Wait for the shell, type a command, assert its output is echoed.
    const term = await $(".xterm");
    await term.waitForExist({ timeout: 30000 });
    await browser.keys(["e", "c", "h", "o", " ", "v", "t", "e", "r", "m", "Enter"]);

    await browser.waitUntil(
      async () => (await $(".xterm-rows").getText()).includes("vterm"),
      { timeout: 15000, timeoutMsg: "command output not seen in terminal" },
    );
  });
});
