import { basename } from "node:path";
import { matchesKey } from "@earendil-works/pi-tui";
import type { ProjectSummary } from "../../core/project.js";
import { bold, accent, dim, spaceBetween } from "../views/style.js";
import { box, fill, listWindow, Panel, row, wrapIndex, type PanelContext } from "./frame.js";

export interface ProjectsPanelOptions {
  projects: readonly ProjectSummary[];
  /** The project folder that is open now, marked with a filled dot. */
  activeProjectDir: string | undefined;
  open(project: ProjectSummary): void;
  close(): void;
}

/** Saved editing projects, to reopen one. */
export class ProjectsPanel extends Panel {
  private selected = 0;

  constructor(context: PanelContext, private readonly options: ProjectsPanelOptions) {
    super(context);
    const active = options.projects.findIndex((item) => same(item.projectDir, options.activeProjectDir));
    this.selected = active >= 0 ? active : 0;
  }

  render(width: number): string[] {
    const { projects, activeProjectDir } = this.options;
    const capacity = Math.max(1, this.rows - 6);
    const { start, end } = listWindow(projects.length, this.selected, capacity);
    const lines = [
      spaceBetween(bold(accent("Projects")), dim(`${projects.length} saved`), Math.max(10, width - 4)),
      ...(projects.length === 0 ? [dim("No saved projects found. Open a video to create one.")] : []),
      ...projects.slice(start, end).map((project, offset) => {
        const index = start + offset;
        const active = same(project.projectDir, activeProjectDir);
        const text = `${index === this.selected ? "›" : " "} ${active ? "●" : "○"} ${project.name}  ${basename(project.sourcePath)} · ${project.versionCount} versions · ${project.currentVersionId}`;
        return row(text, index === this.selected, accent);
      }),
      dim("↑/↓ browse · Enter open · Esc close"),
    ];
    return fill(box(lines, width, { border: "round", color: accent }), width, this.rows);
  }

  handleInput(data: string): void {
    const { projects } = this.options;
    if (matchesKey(data, "escape") || matchesKey(data, "left")) { this.options.close(); return; }
    if (matchesKey(data, "up")) this.selected = wrapIndex(this.selected, -1, projects.length);
    else if (matchesKey(data, "down") || matchesKey(data, "tab")) this.selected = wrapIndex(this.selected, 1, projects.length);
    else if (matchesKey(data, "enter") || matchesKey(data, "right")) {
      const project = projects[this.selected];
      if (project) this.options.open(project);
    }
    this.context.requestRender();
  }
}

function same(left: string, right: string | undefined): boolean {
  return right !== undefined && left.toLowerCase() === right.toLowerCase();
}
