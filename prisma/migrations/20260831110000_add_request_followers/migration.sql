-- Request followers: opt-in visibility list for non-assignee observers.
CREATE TABLE "RequestFollower" (
  "id" SERIAL NOT NULL,
  "request_id" INTEGER NOT NULL,
  "user_id" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RequestFollower_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RequestFollower_request_id_user_id_key" ON "RequestFollower"("request_id", "user_id");
CREATE INDEX "RequestFollower_user_id_idx" ON "RequestFollower"("user_id");

ALTER TABLE "RequestFollower"
ADD CONSTRAINT "RequestFollower_request_id_fkey"
FOREIGN KEY ("request_id") REFERENCES "Request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RequestFollower"
ADD CONSTRAINT "RequestFollower_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
