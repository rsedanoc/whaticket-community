import { Request, Response } from "express";

import { Op, Sequelize } from "sequelize";
import { GroupChat } from "whatsapp-web.js";
import AppError from "../errors/AppError";
import GetTicketWbot from "../helpers/GetTicketWbot";
import formatBody from "../helpers/Mustache";
import { getWbot } from "../libs/wbot";
import Contact from "../models/Contact";
import Message from "../models/Message";
import Ticket from "../models/Ticket";
import TicketLog from "../models/TicketLog";
import CreateTicketService from "../services/TicketServices/CreateTicketService";
import DeleteTicketService from "../services/TicketServices/DeleteTicketService";
// import ListTicketsServicev2 from "../services/TicketServices/ListTicketsServicev2";
import { emitEvent } from "../libs/emitEvent";
import Queue from "../models/Queue";
import User from "../models/User";
import getAndSetBeenWaitingSinceTimestampTicketService from "../services/TicketServices/getAndSetBeenWaitingSinceTimestampTicketService";
import ListTicketsService from "../services/TicketServices/ListTicketsService";
import ShowTicketService from "../services/TicketServices/ShowTicketService";
import UpdateTicketService from "../services/TicketServices/UpdateTicketService";
import SendWhatsAppMessage from "../services/WbotServices/SendWhatsAppMessage";
import { verifyContact } from "../services/WbotServices/wbotMessageListener";
import ShowWhatsAppService from "../services/WhatsappService/ShowWhatsAppService";

type IndexQuery = {
  searchParam: string;
  pageNumber: string;
  status: string;
  date: string;
  showAll: string;
  withUnreadMessages: string;
  queueIds: string;
  whatsappIds: string;
  marketingCampaignIds: string;
  typeIds: string;
  showOnlyMyGroups: string;
  categoryId: string;
  showOnlyWaitingTickets: string;
  filterByUserQueue: string;
};

interface TicketData {
  contactId: number;
  status: string;
  queueId: number;
  userId: number;
  whatsappId?: number;
}

interface TicketLogData {
  ticketId: number;
  userId?: number;
  newUserId?: number;
  logType: string;
  ticketStatus: string;
}

export const index = async (req: Request, res: Response): Promise<Response> => {
  const {
    pageNumber,
    status,
    date,
    searchParam,
    showAll,
    whatsappIds: whatsappIdsStringified,
    queueIds: queueIdsStringified,
    marketingCampaignIds: marketingCampaignIdsStringified,
    typeIds: typeIdsStringified,
    withUnreadMessages,
    showOnlyMyGroups: showOnlyMyGroupsStringified,
    categoryId: categoryIdStringified,
    showOnlyWaitingTickets: showOnlyWaitingTicketsStringified,
    filterByUserQueue: filterByUserQueueStringified
  } = req.query as IndexQuery;

  const userId = req.user.id;

  let marketingCampaignIds: number[] = [];
  let queueIds: number[] = [];
  let whatsappIds: number[] = [];
  let typeIds: string[] = [];
  let showOnlyMyGroups: boolean = false;
  let categoryId: number | null = null;
  let showOnlyWaitingTickets: boolean = false;
  let filterByUserQueue: boolean = false;

  if (typeIdsStringified) {
    typeIds = JSON.parse(typeIdsStringified);
  }

  if (whatsappIdsStringified) {
    whatsappIds = JSON.parse(whatsappIdsStringified);
  }

  if (queueIdsStringified) {
    queueIds = JSON.parse(queueIdsStringified);
  }

  if (marketingCampaignIdsStringified) {
    marketingCampaignIds = JSON.parse(marketingCampaignIdsStringified);
  }

  if (showOnlyMyGroupsStringified) {
    showOnlyMyGroups = JSON.parse(showOnlyMyGroupsStringified);
  }

  if (categoryIdStringified) {
    categoryId = JSON.parse(categoryIdStringified);
  }

  if (showOnlyWaitingTicketsStringified) {
    showOnlyWaitingTickets = JSON.parse(showOnlyWaitingTicketsStringified);
  }

  if (filterByUserQueueStringified) {
    filterByUserQueue = JSON.parse(filterByUserQueueStringified);
  }

  // SI NOS INDICA QUE SE FILTREN POR LA QUEUE DEL USUARIO Y NO HA ESPECIFICADO QUEUEIDS, ENTONCES RECUPERAMOS LAS QUEUE DEL USUARIO Y FILTRAMOS
  if (filterByUserQueue && queueIds.length === 0) {
    const userWithQueues = await User.findByPk(req.user.id, {
      include: [
        {
          model: Queue,
          as: "queues"
        }
      ]
    });

    if (userWithQueues && userWithQueues.queues) {
      queueIds = [...userWithQueues.queues.map(queue => queue.id), null];
    }
  }

  let { tickets, count, hasMore, whereCondition, includeCondition } =
    await ListTicketsService({
      searchParam,
      pageNumber,
      status,
      date,
      showAll,
      userId,
      whatsappIds,
      queueIds,
      marketingCampaignIds,
      typeIds,
      withUnreadMessages,
      showOnlyMyGroups,
      categoryId,
      showOnlyWaitingTickets
    });

  let ticketsToSend = tickets; // Inicializamos con la lista original

  if (process.env.APP_PURPOSE === "comercial") {
    const ticketsIds: number[] = tickets.map(t => t.id);

    let ticketsData = await Ticket.findAll({
      attributes: ["id", "wasSentToZapier"],
      include: [
        {
          model: Message,
          as: "messages",
          required: false
        }
      ],
      where: {
        id: {
          [Op.in]: ticketsIds
        }
      }
    });

    const ticketsToUpdate: number[] = [];

    ticketsData.forEach(ticket => {
      if (!ticket.wasSentToZapier) {
        const messagesFromClient = ticket.messages.filter(m => !m.fromMe);
        const messagesFromConnection = ticket.messages.filter(m => m.fromMe);

        if (
          messagesFromClient.length > 5 &&
          messagesFromConnection.length > 5
        ) {
          ticketsToUpdate.push(ticket.id);
        }
      }
    });

    // Creamos una nueva lista de tickets con la propiedad shouldSendToZapier
    ticketsToSend = tickets.map(ticket => {
      return {
        ...ticket.toJSON(), // Importante: crea una copia del ticket como JSON
        shouldSendToZapier: ticketsToUpdate.includes(ticket.id)
      };
    });
  }

  return res.status(200).json({
    tickets: ticketsToSend,
    count,
    hasMore,
    whereCondition,
    includeCondition
  });
};

export const store = async (req: Request, res: Response): Promise<Response> => {
  const { contactId, status, userId, whatsappId }: TicketData = req.body;

  const ticket = await CreateTicketService({
    contactId,
    status,
    userId,
    whatsappId
  });

  // if (ticket.contact) {
  //   const exclusiveContactsNumbers = await searchIfNumbersAreExclusive({
  //     numbers: [ticket].map(ticket => +ticket.contact.number).filter(n => n)
  //   });

  //   for (const number in exclusiveContactsNumbers) {
  //     if (ticket.contact.number === number) {
  //       ticket.contact.isExclusive = true;
  //     }
  //   }
  // }

  emitEvent({
    to: [ticket.status],
    event: {
      name: "ticket",
      data: {
        action: "update",
        ticket
      }
    }
  });

  return res.status(200).json(ticket);
};

export const show = async (req: Request, res: Response): Promise<Response> => {
  const { ticketId } = req.params;

  const contact = await ShowTicketService(ticketId);

  return res.status(200).json(contact);
};

export const ShowParticipants = async (
  req: Request,
  res: Response
): Promise<Response> => {
  const { ticketId } = req.params;

  // console.log("--- ShowParticipants");

  const ticketInDb = await Ticket.findOne({
    where: {
      id: ticketId
    },
    include: ["contact"]
  });

  if (!ticketInDb) {
    throw new AppError("ERR_TICKET_NOT_FOUND");
  }

  // console.log("--- ShowParticipants 2");

  // Obtiene la información del servicio de WhatsApp
  const wbot = getWbot(ticketInDb.whatsappId);

  if (!wbot) {
    throw new Error("WhatsApp service not found");
  }

  // console.log("--- ShowParticipants 3");

  const chat = await wbot.getChatById(ticketInDb.contact.number + "@g.us");

  if (!chat) {
    throw new Error("Chat not found");
  }

  // console.log("--- ShowParticipants 4");

  const chatDetails = chat as GroupChat;

  // console.log("--- ShowParticipants chatDetails: ", chatDetails);

  const chatParticipants = chatDetails.participants;

  let chatParticipantsContacts = await Contact.findAll({
    where: {
      number: {
        [Op.in]: chatParticipants.map(participant => participant.id.user)
      }
    }
  });

  const chatParticipantsThatAreNotContacts = chatParticipants.filter(
    participant =>
      !chatParticipantsContacts.find(
        contact => contact.number === participant.id.user
      )
  );

  if (chatParticipantsThatAreNotContacts.length) {
    for (const participant of chatParticipantsThatAreNotContacts) {
      console.log("participant", participant);
      const newContact = await wbot.getContactById(participant.id._serialized);
      await verifyContact(newContact);
    }

    chatParticipantsContacts = await Contact.findAll({
      where: {
        number: {
          [Op.in]: chatParticipants.map(participant => participant.id.user)
        }
      }
    });
  }

  // chatParticipants.map(participant => participant.id.user)

  return res.status(200).json(chatParticipantsContacts);
};

export const update = async (
  req: Request,
  res: Response
): Promise<Response> => {
  // console.log("--- ticket update");

  const { ticketId } = req.params;

  let withFarewellMessage = true;
  let leftGroup = false;

  if ("withFarewellMessage" in req.body) {
    withFarewellMessage = req.body.withFarewellMessage;

    delete req.body.withFarewellMessage;
  }

  if ("leftGroup" in req.body) {
    leftGroup = req.body.leftGroup;

    delete req.body.leftGroup;
  }

  const ticketData: TicketData = req.body;

  // console.log("ticketData", ticketData);
  // console.log({ withFarewellMessage });

  const { ticket } = await UpdateTicketService({
    ticketData,
    ticketId
  });

  if (ticket.status === "closed" && !ticket.isGroup && withFarewellMessage) {
    const whatsapp = await ShowWhatsAppService(ticket.whatsappId);

    const { farewellMessage } = whatsapp;

    if (farewellMessage) {
      await SendWhatsAppMessage({
        body: formatBody(farewellMessage, ticket.contact),
        ticket
      });
    }
  }

  if (ticket.status === "closed" && ticket.isGroup && leftGroup) {
    const wbot = await GetTicketWbot(ticket);

    const wbotChat = await wbot.getChatById(
      `${ticket.contact?.number}@${ticket.isGroup ? "g" : "c"}.us`
    );

    const wbotGroupChat = wbotChat as GroupChat;

    await wbotGroupChat.leave();
  }

  return res.status(200).json(ticket);
};

export const remove = async (
  req: Request,
  res: Response
): Promise<Response> => {
  const { ticketId } = req.params;

  const ticket = await DeleteTicketService(ticketId);

  emitEvent({
    to: [ticket.status],
    event: {
      name: "ticket",
      data: {
        action: "delete",
        ticketId: +ticketId
      }
    }
  });

  return res.status(200).json({ message: "ticket deleted" });
};

export const showAllRelatedTickets = async (
  req: Request,
  res: Response
): Promise<Response> => {
  const { ticketId } = req.params;

  const ticket = await ShowTicketService(ticketId);

  const relatedTickets = await Ticket.findAll({
    where: {
      whatsappId: ticket.whatsappId,
      contactId: ticket.contactId
    },
    order: [["lastMessageTimestamp", "ASC"]],
    include: [
      {
        model: Message,
        as: "messages",
        order: [["timestamp", "ASC"]],
        where: {
          timestamp: {
            [Op.gte]: Sequelize.literal(
              `(SELECT UNIX_TIMESTAMP(Tickets.createdAt) FROM Tickets WHERE Tickets.id = ticketId)`
            )
          }
        },
        limit: 1,
        required: false
      }
    ]
  });

  if (!relatedTickets || relatedTickets.length === 0) {
    throw new AppError("ERR_NO_TICKET_relateds_FOUND", 404);
  }

  return res.status(200).json(relatedTickets);
};

export const createTicketLog = async (
  req: Request,
  res: Response
): Promise<Response> => {
  const ticketLog: TicketLogData = req.body;

  try {
    const newTicketLog = await TicketLog.create(ticketLog);

    if (!newTicketLog) {
      console.log("error");

      throw new AppError("ERR_TICKET_NOT_FOUND");
    }
  } catch (error) {
    console.log("error", error);

    throw new AppError("ERR_TICKET_NOT_FOUND");
  }

  return res.status(200).json({});
};

export const showTicketsRelationsWithTraza = async (
  req: Request,
  res: Response
): Promise<Response> => {
  const ticketsIds: number[] = req.body;

  let tickets = await Ticket.findAll({
    attributes: ["id", "wasSentToZapier"],
    include: [
      {
        model: Message,
        as: "messages",
        required: false
      }
    ],
    where: {
      id: {
        [Op.in]: ticketsIds
      }
    }
  });

  tickets = tickets.map(ticket => {
    if (!ticket.wasSentToZapier) {
      const messagesFromClient = ticket.messages.filter(m => !m.fromMe);
      const messagesFromConection = ticket.messages.filter(m => m.fromMe);

      if (messagesFromClient.length > 5 && messagesFromConection.length > 5) {
        // @ts-ignore
        ticket.shouldSendToZapier = true;
      }
    }

    return ticket;
  });

  return res.status(200).json(tickets);
};

export const getAndSetBeenWaitingSinceTimestampToAllTheTickets = async (
  req: Request,
  res: Response
): Promise<Response> => {
  const { limit, offset } = req.body;

  if (!Number.isInteger(limit) || !Number.isInteger(offset)) {
    throw new AppError("ERR_INVALID_PARAMS");
  }

  const tickets = await Ticket.findAll({
    offset,
    limit
  });

  await getAndSetBeenWaitingSinceTimestampTicketService(tickets);

  return res.status(200).json({
    count: tickets.length,
    firstId: tickets[0].id,
    lastId: tickets[tickets.length - 1].id
  });
};
