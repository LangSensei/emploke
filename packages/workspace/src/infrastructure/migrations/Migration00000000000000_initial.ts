import { Migration } from "@mikro-orm/migrations";

/**
 * Initial schema for the workspace pkg's global registry DB.
 */
export class Migration00000000000000_initial extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      'CREATE TABLE "workspaces" (' +
        '"id" uuid NOT NULL, ' +
        '"workspace_dir" text NOT NULL, ' +
        '"name" text NOT NULL, ' +
        '"created_at" text NOT NULL, ' +
        '"last_opened_at" text NULL, ' +
        'PRIMARY KEY ("id"), ' +
        'CONSTRAINT "workspaces_workspace_dir_unique" UNIQUE ("workspace_dir")' +
        ");",
    );
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE "workspaces";');
  }
}
