/**
 * 以顶层表单 POST 的方式跳转。
 *
 * 会改变服务端状态的跳转（登出、绑定第三方账号）不能再用 GET：跨站链接也能
 * 触发 GET 并带上 SameSite=Lax 的会话 cookie。表单 POST 会携带 Origin，
 * 服务端可以据此拒绝跨站请求，同时仍然能跟随服务端返回的 302 跳转。
 */
export function postNavigate(url: string, fields: Record<string, string> = {}): void {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = url;
  form.style.display = "none";
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}
