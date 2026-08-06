-- CreateTable
CREATE TABLE "TrelloSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "apiKey" TEXT,
    "apiToken" TEXT,
    "updatedById" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrelloSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrelloUserBoard" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "boardId" TEXT NOT NULL,
    "boardName" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "listName" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrelloUserBoard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrelloUserBoard_userId_key" ON "TrelloUserBoard"("userId");

-- AddForeignKey
ALTER TABLE "TrelloUserBoard" ADD CONSTRAINT "TrelloUserBoard_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
