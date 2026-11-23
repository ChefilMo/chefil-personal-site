/** 把站内路径加上部署 base 前缀（GitHub Pages 项目页必须） */
export function withBase(path: string): string {
  // BASE_URL 不保证带尾斜杠（'/chefil-personal-site'），统一规范化
  const base = import.meta.env.BASE_URL.endsWith('/')
    ? import.meta.env.BASE_URL
    : import.meta.env.BASE_URL + '/';
  return base + path.replace(/^\//, '');
}
